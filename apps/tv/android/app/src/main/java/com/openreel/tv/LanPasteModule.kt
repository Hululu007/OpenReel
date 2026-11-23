package com.openreel.tv

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * 手机中转（局域网）模块 —— TV 端「AI 导入」用。
 *
 * 背景：电视没有 AI 应用，系统 WebView 过旧且无法升级，遥控器也无法操作 AI 网页与登录。
 * 故 TV 只在局域网起一个一次性 HTTP 服务，把手机页面（提示词 + 粘贴框）交给手机浏览器；
 * 用户在手机上用自己的 AI App 对话，再把回答提交回来，TV 轮询取到文本后填入导入页。
 *
 * 生命周期：start() 绑定随机端口 + 随机 token；stop() 关闭；超时自动关闭；
 * 模块 invalidate（RN 卸载）时强制关闭，避免端口泄漏。仅监听局域网，token 为唯一凭据，
 * 单次请求体上限 512KB。
 */
class LanPasteModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "LanPaste"

  private var serverSocket: ServerSocket? = null
  private var acceptThread: Thread? = null
  private var pool: ExecutorService? = null
  private val running = AtomicBoolean(false)
  private val pendingText = AtomicReference<String?>(null)

  @Volatile
  private var token: String = ""

  @Volatile
  private var pageHtml: String = ""

  @ReactMethod
  fun start(html: String, timeoutMs: Double, promise: Promise) {
    stopInternal()
    try {
      val socket = ServerSocket(0)
      serverSocket = socket
      pageHtml = html
      token = randomToken()
      pendingText.set(null)
      running.set(true)

      val executor = Executors.newFixedThreadPool(3)
      pool = executor
      val acceptor = Thread { acceptLoop(socket, executor) }
      acceptor.isDaemon = true
      acceptor.name = "LanPasteAccept"
      acceptThread = acceptor
      acceptor.start()

      val timeout = timeoutMs.toLong().coerceIn(30_000L, 3_600_000L)
      val stopper = Thread {
        try {
          Thread.sleep(timeout)
        } catch (_: InterruptedException) {
          return@Thread
        }
        if (running.get()) stopInternal()
      }
      stopper.isDaemon = true
      stopper.name = "LanPasteTimeout"
      stopper.start()

      val ip = localIpv4Address() ?: "127.0.0.1"
      val result = Arguments.createMap()
      result.putString("ip", ip)
      result.putInt("port", socket.localPort)
      result.putString("token", token)
      result.putString("url", "http://$ip:${socket.localPort}/?t=$token")
      promise.resolve(result)
    } catch (e: Exception) {
      stopInternal()
      promise.reject("LAN_PASTE_START_FAILED", e.message ?: "start failed", e)
    }
  }

  /** 取手机提交的文本（取走即清空）；没有则返回 null */
  @ReactMethod
  fun poll(promise: Promise) {
    promise.resolve(pendingText.getAndSet(null))
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopInternal()
    promise.resolve(true)
  }

  override fun invalidate() {
    stopInternal()
    super.invalidate()
  }

  private fun stopInternal() {
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
    pendingText.set(null)
    token = ""
    pageHtml = ""
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

  private fun handleClient(client: Socket) {
    try {
      client.soTimeout = 8000
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
        val name = line.substring(0, idx).trim().lowercase()
        if (name == "content-length") {
          contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: 0
        }
      }

      val path = target.substringBefore('?')
      val queryToken = queryParam(target, "t")
      val body = if (contentLength > 0) readBody(input, contentLength.coerceAtMost(MAX_BODY)) else ""
      val bodyWasTruncated = contentLength > MAX_BODY

      when {
        method == "GET" && (path == "/" || path == "/index.html") -> {
          if (queryToken != token) {
            respond(client, 403, "text/plain; charset=utf-8", "链接已失效，请在电视上重新扫码。")
          } else {
            respond(client, 200, "text/html; charset=utf-8", pageHtml.replace("__TOKEN__", token))
          }
        }

        method == "POST" && path == "/submit" -> {
          if (queryToken != token) {
            respond(client, 403, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"invalid token\"}")
          } else if (bodyWasTruncated) {
            respond(client, 413, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"body too large\"}")
          } else {
            val text = extractText(body)
            if (text.isNullOrBlank()) {
              respond(client, 400, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"empty\"}")
            } else {
              pendingText.set(text)
              respond(client, 200, "application/json; charset=utf-8", "{\"ok\":true}")
            }
          }
        }

        method == "GET" && path == "/ping" -> respond(client, 200, "text/plain; charset=utf-8", "ok")

        else -> respond(client, 404, "text/plain; charset=utf-8", "not found")
      }
    } catch (_: Exception) {
      // 单个连接异常不影响服务
    } finally {
      try {
        client.close()
      } catch (_: Exception) {
      }
    }
  }

  private fun respond(client: Socket, status: Int, contentType: String, body: String) {
    val bytes = body.toByteArray(Charsets.UTF_8)
    val header = buildString {
      append("HTTP/1.1 $status ").append(statusText(status)).append("\r\n")
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
    413 -> "Payload Too Large"
    else -> "OK"
  }

  private fun extractText(body: String): String? {
    val trimmed = body.trim()
    if (trimmed.isEmpty()) return null
    if (trimmed.startsWith("{")) {
      return try {
        val obj = JSONObject(trimmed)
        val text = if (obj.has("text")) obj.getString("text") else ""
        text.trim().ifEmpty { null }
      } catch (_: Exception) {
        trimmed
      }
    }
    return trimmed
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

  private fun readBody(input: InputStream, length: Int): String {
    val buffer = ByteArray(length)
    var read = 0
    while (read < length) {
      val n = input.read(buffer, read, length - read)
      if (n <= 0) break
      read += n
    }
    return if (read <= 0) "" else String(buffer, 0, read, Charsets.UTF_8)
  }

  private fun queryParam(target: String, name: String): String? {
    val query = target.substringAfter('?', "")
    if (query.isEmpty()) return null
    for (pair in query.split('&')) {
      val idx = pair.indexOf('=')
      if (idx <= 0) continue
      if (pair.substring(0, idx) != name) continue
      return try {
        java.net.URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
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
          // wlan / eth 优先，避免挑到 p2p / 虚拟网卡
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
    private const val MAX_BODY = 512 * 1024
  }
}
