package com.beatify.app.data

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

object StreamExtractor {

    private const val TAG = "JioSaavnApi"
    private const val SERVER = "https://beatify-backend-7e5b.onrender.com"

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    fun getStreamUrl(songId: String): String? {
        Log.d(TAG, "=== GET STREAM: $songId ===")

        // Get encrypted URL from server, decrypt on phone
        val url1 = tryServerEncrypted(songId)
        if (!url1.isNullOrBlank()) return url1

        // Direct fallback
        val url2 = tryJioSaavnDirect(songId)
        if (!url2.isNullOrBlank()) return url2

        Log.e(TAG, "All extractors failed for: $songId")
        return null
    }

    private fun tryServerEncrypted(songId: String): String? {
        return try {
            val url = "$SERVER/encrypted/$songId"
            val body = get(url) ?: return null
            Log.d(TAG, "Server encrypted response: $body")

            val json = JSONObject(body)
            val encrypted = json.optString("encrypted", "")
            val plain = json.optString("plain", "")

            if (encrypted.isNotBlank()) {
                val decrypted = desDecrypt(encrypted)
                Log.d(TAG, "Decrypted: $decrypted")
                if (!decrypted.isNullOrBlank() && decrypted.startsWith("http")) {
                    return upgradeQuality(decrypted)
                }
            }

            if (plain.isNotBlank() && !plain.contains("jiotune")) {
                return upgradeQuality(plain)
            }

            null
        } catch (e: Exception) {
            Log.e(TAG, "Server encrypted error: ${e.message}")
            null
        }
    }

    private fun tryJioSaavnDirect(songId: String): String? {
        return try {
            val url = "https://www.jiosaavn.com/api.php" +
                    "?__call=song.getDetails&cc=in&_marker=0&_format=json&pids=$songId"
            val body = get(url) ?: return null
            val root = JSONObject(body)
            val songObj = if (root.has(songId)) root.getJSONObject(songId) else root

            val encrypted = songObj.optString("encrypted_media_url", "")
            if (encrypted.isNotBlank()) {
                val decrypted = desDecrypt(encrypted)
                if (!decrypted.isNullOrBlank() && decrypted.startsWith("http")) {
                    return upgradeQuality(decrypted)
                }
            }

            val plain = songObj.optString("media_url", "")
                .ifBlank { songObj.optString("vlink", "") }
            if (plain.isNotBlank() && !plain.contains("jiotune")) {
                return upgradeQuality(plain)
            }
            null
        } catch (e: Exception) {
            Log.e(TAG, "Direct error: ${e.message}")
            null
        }
    }

    private fun desDecrypt(encrypted: String): String? {
        val keys = listOf("38346591", "34256897", "33445512")
        for (key in keys) {
            try {
                val keySpec = SecretKeySpec(key.toByteArray(Charsets.UTF_8), "DES")
                val cipher = Cipher.getInstance("DES/ECB/PKCS5Padding")
                cipher.init(Cipher.DECRYPT_MODE, keySpec)
                val result = String(
                    cipher.doFinal(android.util.Base64.decode(encrypted, android.util.Base64.DEFAULT))
                ).trim()
                if (result.startsWith("http")) return result
            } catch (e: Exception) { }
        }
        return null
    }

    private fun upgradeQuality(url: String) = url
        .replace("_12.mp4", "_320.mp4")
        .replace("_48.mp4", "_320.mp4")
        .replace("_96.mp4", "_320.mp4")
        .replace("_160.mp4", "_320.mp4")

    private fun get(url: String): String? {
        return try {
            val request = Request.Builder()
                .url(url)
                .addHeader("User-Agent", "BeatifyApp/1.0")
                .build()
            val response = client.newCall(request).execute()
            if (!response.isSuccessful) null else response.body?.string()
        } catch (e: Exception) { null }
    }
}
