package com.aimana.joi.remote

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.DigestInputStream
import java.security.MessageDigest

internal object ResultExportIntegrity {
    fun copyAndVerify(source: File, destination: () -> OutputStream, readBack: () -> InputStream) {
        val sourceHash = MessageDigest.getInstance("SHA-256")
        val written = destination().use { output ->
            DigestInputStream(source.inputStream(), sourceHash).use { it.copyTo(output) }
        }
        check(written > 0 && written == source.length())
        val savedHash = MessageDigest.getInstance("SHA-256")
        var read = 0L
        DigestInputStream(readBack(), savedHash).use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count == -1) break
                read += count
            }
        }
        check(read == written && MessageDigest.isEqual(sourceHash.digest(), savedHash.digest()))
    }
}
