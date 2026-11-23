package com.openreel.tvlauncher

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * 「手机 → 电视 整库替换」原生模块。
 *
 * 手机 App 扫电视二维码后，把整份 SQLite 快照分片上传到本机；本机在**不动旧库**的前提下
 * 先落临时文件并做四项校验，全部通过后才原子替换 `files/SQLite/movieapp.db` 并重启应用。
 *
 * 设计要点（见 .trae/documents/mobile_to_tv_library_sync_plan.md）：
 *  - 不备份：靠「先校验、后原子替换」保证旧库不被破坏；结构版本严格相等 => 替换后不跑迁移；
 *  - 分片上传可续传（offset 必须等于已收字节数）；base64 JSON 与原始二进制两种分片都接受；
 *  - 校验：大小 / PRAGMA quick_check / 必需表 / migrations MAX(version) / sync.lastExport 标记行；
 *  - 替换后通过 AlarmManager 拉起 MainActivity 并结束进程，避免 JS 侧旧 store/旧连接残留。
 *
 * 与 LanPasteModule 一样是 app 内手动注册的原生模块（见 MainApplication 的 PackageList）。
 */
class LibrarySyncModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "LibrarySync"

  private val dbDir: File get() = File(reactContext.filesDir, "SQLite")
  private val dbFile: File get() = File(dbDir, "movieapp.db")
  private val tmpFile: File get() = File(dbDir, "incoming.db.tmp")

  private val handler = Handler(Looper.getMainLooper())

  @Volatile private var token: String = ""
  @Volatile private var expectedSchema: Int = -1
  @Volatile private var phase: String = PHASE_IDLE
  @Volatile private var message: String = ""
  @Volatile private var totalBytes: Long = 0L
  @Volatile private var expectedSize: Long = -1L
  @Volatile private var expectedNonce: String = ""
  @Volatile private var summary: WritableMap? = null
  private val receivedBytes = AtomicLong(0)

  private var serverSocket: ServerSocket? = null
  private var pool: ExecutorService? = null
  private var acceptThread: Thread? = null
  private val running = java.util.concurrent.atomic.AtomicBoolean(false)

  // —— JS API ——

  @ReactMethod
  fun startServer(schemaVersion: Double, timeoutMs: Double, promise: Promise) {
    stopServer(deleteTemp = true)
    try {
      val socket = ServerSocket(0)
      serverSocket = socket
      token = randomToken()
      expectedSchema = schemaVersion.toInt()
      phase = PHASE_SERVING
      message = ""
      totalBytes = 0
      expectedSize = -1L
      expectedNonce = ""
      receivedBytes.set(0)
      running.set(true)

      val executor = Executors.newFixedThreadPool(3)
      pool = executor
      val acceptor = Thread { acceptLoop(socket, executor) }
      acceptor.isDaemon = true
      acceptor.name = "LibrarySyncAccept"
      acceptThread = acceptor
      acceptor.start()

      val timeout = timeoutMs.toLong().coerceIn(60_000L, 3_600_000L)
      val stopper = Thread {
        try {
          Thread.sleep(timeout)
        } catch (_: InterruptedException) {
          return@Thread
        }
        if (running.get() && phase != PHASE_APPLYING) {
          phase = PHASE_ERROR
          message = "等待手机连接超时，已关闭同步服务"
          stopServer(deleteTemp = true)
        }
      }
      stopper.isDaemon = true
      stopper.start()

      val ip = localIpv4Address() ?: "127.0.0.1"
      val result = Arguments.createMap()
      result.putString("ip", ip)
      result.putInt("port", socket.localPort)
      result.putString("token", token)
      result.putString("url", buildSyncUrl(ip, socket.localPort, token, expectedSchema))
      result.putInt("schemaVersion", expectedSchema)
      result.putDouble("dbSize", currentDbBytes().toDouble())
      result.putDouble("freeBytes", freeBytes().toDouble())
      promise.resolve(result)
    } catch (e: Exception) {
      stopServer(deleteTemp = true)
      promise.reject("SYNC_START_FAILED", e.message ?: "start failed", e)
    }
  }

  @ReactMethod
  fun poll(promise: Promise) {
    val map = Arguments.createMap()
    map.putString("phase", phase)
    map.putString("message", message)
    map.putDouble("received", receivedBytes.get().toDouble())
    map.putDouble("total", totalBytes.toDouble())
    map.putMap("summary", summary)
    promise.resolve(map)
  }

  @ReactMethod
  fun applyAndRestart(promise: Promise) {
    if (phase != PHASE_READY) {
      promise.reject("NOT_READY", "尚未收到并校验手机数据")
      return
    }
    phase = PHASE_APPLYING
    message = "正在替换电视数据库…"
    try {
      // 旧库的 WAL / SHM 必须先清掉：否则新库打开时会被旧日志回放污染
      File(dbDir, "movieapp.db-wal").delete()
      File(dbDir, "movieapp.db-shm").delete()
      File(dbDir, "movieapp.db-journal").delete()
      atomicReplace(tmpFile, dbFile)
      promise.resolve(true)
    } catch (e: Exception) {
      phase = PHASE_ERROR
      message = "替换数据库失败：${e.message}"
      promise.reject("SYNC_APPLY_FAILED", e.message, e)
      return
    }
    // 先让 Promise 回到 JS（页面可显示「正在重启」），随后拉起应用并结束当前进程
    handler.postDelayed({ restartApp() }, 600)
  }

  @ReactMethod
  fun cancel(promise: Promise) {
    stopServer(deleteTemp = true)
    phase = PHASE_IDLE
    message = ""
    summary = null
    receivedBytes.set(0)
    totalBytes = 0
    promise.resolve(true)
  }

  override fun invalidate() {
    if (phase != PHASE_APPLYING) stopServer(deleteTemp = true)
    super.invalidate()
  }

  // —— 服务生命周期 ——

  private fun stopServer(deleteTemp: Boolean) {
    running.set(false)
    try {
      serverSocket?.close()
    } catch (_: Exception) {
    }
    serverSocket = null
    acceptThread?.interrupt()
    acceptThread = null
    try {
      pool?.shutdownNow()
    } catch (_: Exception) {
    }
    pool = null
    if (deleteTemp) {
      try {
        tmpFile.delete()
      } catch (_: Exception) {
      }
    }
  }

  private fun acceptLoop(socket: ServerSocket, executor: ExecutorService) {
    while (running.get()) {
      try {
        val client = socket.accept()
        executor.execute { handleClient(client) }
      } catch (e: Exception) {
        if (!running.get()) return
        try {
          Thread.sleep(50)
        } catch (_: InterruptedException) {
          return
        }
      }
    }
  }

  // —— 请求处理 ——

  private fun handleClient(client: Socket) {
    try {
      client.soTimeout = 20000
      val input = client.getInputStream()
      val requestLine = readLine(input)
      if (requestLine.isEmpty()) return
      val parts = requestLine.split(" ")
      val method = parts.getOrNull(0) ?: ""
      val target = parts.getOrNull(1) ?: ""

      var contentLength = 0
      while (true) {
        val line = readLine(input)
        if (line.isEmpty()) break
        val idx = line.indexOf(':')
        if (idx <= 0) continue
        if (line.substring(0, idx).trim().lowercase() == "content-length") {
          contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: 0
        }
      }

      val path = target.substringBefore('?')
      val queryToken = queryParam(target, "t")
      if (queryToken != token) {
        respond(client, 403, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"invalid token\"}")
        return
      }

      val body = if (contentLength > 0) readBody(input, contentLength.coerceAtMost(MAX_BODY)) else ByteArray(0)
      if (contentLength > MAX_BODY) {
        respond(client, 413, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"chunk too large\"}")
        return
      }

      when {
        method == "GET" && path == "/sync/meta" -> {
          val json = JSONObject()
          json.put("ok", true)
          json.put("schemaVersion", expectedSchema)
          json.put("received", receivedBytes.get())
          json.put("phase", phase)
          json.put("dbSize", currentDbBytes())
          json.put("freeBytes", freeBytes())
          json.put("phase", phase)
          json.put("summary", summaryToJson(summary))
          respond(client, 200, "application/json; charset=utf-8", json.toString())
        }

        method == "POST" && path == "/sync/reset" -> {
          receivedBytes.set(0)
          totalBytes = 0
          expectedSize = -1L
          expectedNonce = ""
          summary = null
          phase = PHASE_SERVING
          message = ""
          try {
            tmpFile.delete()
          } catch (_: Exception) {
          }
          respond(client, 200, "application/json; charset=utf-8", "{\"ok\":true}")
        }

        method == "POST" && path == "/sync/chunk" -> handleChunk(client, target, body)

        method == "POST" && path == "/sync/finish" -> handleFinish(client, body)

        else -> respond(client, 404, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"not found\"}")
      }
    } catch (e: Exception) {
      try {
        phase = PHASE_ERROR
        message = "接收数据失败：${e.message}"
      } catch (_: Exception) {
      }
    } finally {
      try {
        client.close()
      } catch (_: Exception) {
      }
    }
  }

  private fun handleChunk(client: Socket, target: String, rawBody: ByteArray) {
    val offset = queryParam(target, "offset")?.toLongOrNull() ?: 0L
    val total = queryParam(target, "total")?.toLongOrNull() ?: 0L
    if (total > 0) totalBytes = total

    // 支持两种分片形态：原始二进制，或 JSON {"data":"<base64>"}（手机端 Base64 读取文件更省事）
    val bytes: ByteArray = if (rawBody.isNotEmpty() && rawBody[0].toInt() == '{'.code) {
      try {
        val json = JSONObject(String(rawBody, Charsets.UTF_8))
        Base64.decode(json.optString("data"), Base64.DEFAULT)
      } catch (e: Exception) {
        respond(client, 400, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"bad base64 chunk\"}")
        return
      }
    } else rawBody

    if (offset != receivedBytes.get()) {
      val json = JSONObject()
      json.put("ok", false)
      json.put("error", "offset mismatch")
      json.put("received", receivedBytes.get())
      respond(client, 409, "application/json; charset=utf-8", json.toString())
      return
    }

    try {
      RandomAccessFile(tmpFile, "rw").use { raf ->
        raf.seek(offset)
        raf.write(bytes)
      }
      receivedBytes.set(offset + bytes.size)
      phase = PHASE_UPLOADING
      message = "正在接收手机数据…"
      if (offset == 0L) summary = null
      val json = JSONObject()
      json.put("ok", true)
      json.put("received", receivedBytes.get())
      respond(client, 200, "application/json; charset=utf-8", json.toString())
    } catch (e: Exception) {
      phase = PHASE_ERROR
      message = "写入临时文件失败：${e.message}"
      respond(client, 500, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"write failed\"}")
    }
  }

  private fun handleFinish(client: Socket, rawBody: ByteArray) {
    val body = try {
      JSONObject(String(rawBody, Charsets.UTF_8))
    } catch (e: Exception) {
      JSONObject()
    }
    expectedSize = body.optLong("size", -1L)
    expectedNonce = body.optString("nonce", "")
    phase = PHASE_VALIDATING
    message = "正在校验手机数据库…"
    summary = null
    // 校验可能耗时几十秒（274MB 库 quick_check），异步执行并立即响应，
    // 手机端改用 /sync/meta 轮询结果，避免单次 HTTP 超时。
    respond(client, 200, "application/json; charset=utf-8", "{\"ok\":true,\"status\":\"validating\"}")
    val sizeSnapshot = expectedSize
    val nonceSnapshot = expectedNonce
    Thread {
      val failure = validateSnapshot(sizeSnapshot, nonceSnapshot)
      if (failure != null) {
        phase = PHASE_ERROR
        message = failure
        summary = null
        try {
          tmpFile.delete()
        } catch (_: Exception) {
        }
        receivedBytes.set(0)
      } else {
        phase = PHASE_READY
        message = "校验通过，可以应用到电视"
      }
    }.apply { isDaemon = true }.start()
  }

  /** 返回 null 表示校验通过，否则返回失败原因 */
  private fun validateSnapshot(declaredSize: Long, markerNonce: String): String? {
    if (!tmpFile.exists()) return "没有收到手机数据"
    if (declaredSize >= 0 && tmpFile.length() != declaredSize) {
      return "文件大小不一致（收到 ${tmpFile.length()}，声明 $declaredSize）"
    }
    if (tmpFile.length() < 4096) return "文件过小，可能上传不完整"

    var db: SQLiteDatabase? = null
    try {
      db = SQLiteDatabase.openDatabase(tmpFile.path, null, SQLiteDatabase.OPEN_READONLY)

      val check = querySingleString(db, "PRAGMA quick_check")
      if (check != "ok") return "数据库自检未通过：${check ?: "unknown"}"

      val version = querySingleString(db, "SELECT MAX(version) FROM migrations")?.toIntOrNull() ?: -1
      if (version != expectedSchema) {
        return "数据库结构版本不一致（手机 $version / 电视 $expectedSchema），请先把两端升级到同一版本"
      }

      val requiredTables = listOf(
        "media", "media_source", "video_source", "favorite", "watch_history",
        "episode", "play_source", "system_config", "migrations",
      )
      val existing = HashSet<String>()
      db.rawQuery("SELECT name FROM sqlite_master WHERE type = 'table'", null).use { c ->
        while (c.moveToNext()) existing.add(c.getString(0))
      }
      val missing = requiredTables.filter { !existing.contains(it) }
      if (missing.isNotEmpty()) return "缺少数据表：${missing.joinToString(",")}"

      val markerRaw = querySingleString(db, "SELECT value FROM system_config WHERE key = 'sync.lastExport'")
      if (markerRaw.isNullOrBlank()) return "缺少同步标记行，无法确认数据完整性"
      if (markerNonce.isNotBlank()) {
        val marker = try {
          JSONObject(markerRaw)
        } catch (e: Exception) {
          return "同步标记行格式不正确"
        }
        val nonce = marker.optString("nonce", "")
        if (nonce != markerNonce) return "同步标记不匹配，数据可能不是同一次导出的"
      }

      val media = queryCount(db, "media")
      val sources = queryCount(db, "video_source")
      val favorites = queryCount(db, "favorite")
      val history = queryCount(db, "watch_history")

      if (media <= 0) return "手机数据库里没有片库数据"

      val map = Arguments.createMap()
      map.putInt("schemaVersion", version)
      map.putDouble("bytes", tmpFile.length().toDouble())
      map.putInt("media", media)
      map.putInt("sources", sources)
      map.putInt("favorites", favorites)
      map.putInt("history", history)
      summary = map
      return null
    } catch (e: Exception) {
      return "打不开手机数据库：${e.message}"
    } finally {
      try {
        db?.close()
      } catch (_: Exception) {
      }
    }
  }

  // —— 工具 ——

  private fun atomicReplace(from: File, to: File) {
    if (!from.exists()) throw IllegalStateException("临时文件不存在")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        Files.move(
          from.toPath(),
          to.toPath(),
          StandardCopyOption.REPLACE_EXISTING,
          StandardCopyOption.ATOMIC_MOVE,
        )
        return
      } catch (_: Exception) {
        // 同一目录下 ATOMIC_MOVE 一般可用；个别 ROM/文件系统不支持时退化为普通替换
        Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING)
        return
      }
    }
    // API 24/25 没有 java.nio.file：同一目录下 File.renameTo 在 POSIX 语义上即覆盖替换
    if (!from.renameTo(to)) {
      if (!to.delete() || !from.renameTo(to)) throw IOException("替换数据库文件失败")
    }
  }

  private fun restartApp() {
    try {
      val ctx = reactContext
      val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      val flags = PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val pi = PendingIntent.getActivity(ctx, 0, intent, flags)
      val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val triggerAt = System.currentTimeMillis() + 800
      try {
        am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi)
      } catch (_: Exception) {
        am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi)
      }
    } catch (_: Exception) {
      // 拉起失败时用户手动打开应用也能生效（数据已经替换完成）
    }
    android.os.Process.killProcess(android.os.Process.myPid())
  }

  private fun currentDbBytes(): Long {
    var total = 0L
    for (name in listOf("movieapp.db", "movieapp.db-wal")) {
      try {
        total += File(dbDir, name).length()
      } catch (_: Exception) {
      }
    }
    return total
  }

  private fun freeBytes(): Long {
    return try {
      StatFs(reactContext.filesDir.path).availableBytes
    } catch (_: Exception) {
      0L
    }
  }

  private fun buildSyncUrl(ip: String, port: Int, token: String, schemaVersion: Int): String {
    return "openreel-sync://sync?ip=$ip&port=$port&t=$token&sv=$schemaVersion&v=1"
  }

  private fun summaryToJson(map: WritableMap?): JSONObject {
    val json = JSONObject()
    if (map == null) return json
    map.toHashMap().forEach { (key, value) -> json.put(key, value) }
    return json
  }

  private fun querySingleString(db: SQLiteDatabase, sql: String): String? {
    db.rawQuery(sql, null).use { c ->
      if (c.moveToFirst() && !c.isNull(0)) return c.getString(0)
    }
    return null
  }

  private fun queryCount(db: SQLiteDatabase, table: String): Int {
    db.rawQuery("SELECT COUNT(*) FROM $table", null).use { c ->
      if (c.moveToFirst()) return c.getInt(0)
    }
    return 0
  }

  private fun respond(client: Socket, status: Int, contentType: String, body: String) {
    val bytes = body.toByteArray(Charsets.UTF_8)
    val header = buildString {
      append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n")
      append("Content-Type: ").append(contentType).append("\r\n")
      append("Content-Length: ").append(bytes.size).append("\r\n")
      append("Cache-Control: no-store\r\n")
      append("Connection: close\r\n\r\n")
    }
    val out: OutputStream = client.getOutputStream()
    out.write(header.toByteArray(Charsets.UTF_8))
    out.write(bytes)
    out.flush()
  }

  private fun statusText(status: Int): String = when (status) {
    200 -> "OK"
    400 -> "Bad Request"
    403 -> "Forbidden"
    404 -> "Not Found"
    409 -> "Conflict"
    413 -> "Payload Too Large"
    500 -> "Internal Server Error"
    else -> "OK"
  }

  private fun readLine(input: InputStream): String {
    val sb = StringBuilder()
    var b = input.read()
    while (b != -1) {
      if (b == '\n'.code) {
        val len = sb.length
        if (len > 0 && sb[len - 1] == '\r') sb.setLength(len - 1)
        return sb.toString()
      }
      sb.append(b.toChar())
      b = input.read()
    }
    return sb.toString()
  }

  private fun readBody(input: InputStream, length: Int): ByteArray {
    val buffer = ByteArray(length)
    var read = 0
    while (read < length) {
      val n = input.read(buffer, read, length - read)
      if (n <= 0) break
      read += n
    }
    return if (read <= 0) ByteArray(0) else buffer.copyOf(read)
  }

  private fun queryParam(target: String, name: String): String? {
    val query = target.substringAfter('?', "")
    if (query.isEmpty()) return null
    for (pair in query.split('&')) {
      val idx = pair.indexOf('=')
      if (idx <= 0) continue
      if (pair.substring(0, idx) != name) continue
      return try {
        URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
      } catch (_: Exception) {
        pair.substring(idx + 1)
      }
    }
    return null
  }

  private fun localIpv4Address(): String? {
    return try {
      var fallback: String? = null
      val interfaces = NetworkInterface.getNetworkInterfaces() ?: return null
      while (interfaces.hasMoreElements()) {
        val nif = interfaces.nextElement()
        if (!nif.isUp || nif.isLoopback) continue
        val name = nif.name ?: ""
        for (addr in nif.inetAddresses) {
          val ip = addr as? Inet4Address ?: continue
          if (ip.isLoopbackAddress || ip.isLinkLocalAddress) continue
          val host = ip.hostAddress ?: continue
          if (name.startsWith("wlan") || name.startsWith("eth")) return host
          if (fallback == null) fallback = host
        }
      }
      fallback
    } catch (_: Exception) {
      null
    }
  }

  private fun randomToken(): String {
    val bytes = ByteArray(8)
    SecureRandom().nextBytes(bytes)
    val sb = StringBuilder()
    for (b in bytes) sb.append(String.format("%02x", b))
    return sb.toString()
  }

  companion object {
    private const val PHASE_IDLE = "idle"
    private const val PHASE_SERVING = "serving"
    private const val PHASE_UPLOADING = "uploading"
    private const val PHASE_VALIDATING = "validating"
    private const val PHASE_READY = "ready"
    private const val PHASE_APPLYING = "applying"
    private const val PHASE_ERROR = "error"
    private const val MAX_BODY = 16 * 1024 * 1024
  }
}
