package com.aimana.joi.remote

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ResultExportIntegrityTest {
    private fun withSource(block: (java.io.File, ByteArray) -> Unit) {
        val file = Files.createTempFile("joi-export-test-", ".bin").toFile()
        val bytes = ByteArray(16385) { (it % 251).toByte() }
        try {
            file.writeBytes(bytes)
            block(file, bytes)
        } finally {
            file.delete()
        }
    }

    @Test fun verifiesPublishedBytes() = withSource { source, expected ->
        val output = ByteArrayOutputStream()
        ResultExportIntegrity.copyAndVerify(source, { output }, { ByteArrayInputStream(output.toByteArray()) })
        assertArrayEquals(expected, output.toByteArray())
    }

    @Test fun rejectsTruncatedDestination() = withSource { source, bytes ->
        assertThrows(IllegalStateException::class.java) {
            ResultExportIntegrity.copyAndVerify(source, { ByteArrayOutputStream() }, { ByteArrayInputStream(bytes.copyOf(5)) })
        }
    }

    @Test fun rejectsSameLengthCorruption() = withSource { source, bytes ->
        val damaged = bytes.clone().apply { this[8000] = (this[8000].toInt() xor 1).toByte() }
        assertThrows(IllegalStateException::class.java) {
            ResultExportIntegrity.copyAndVerify(source, { ByteArrayOutputStream() }, { ByteArrayInputStream(damaged) })
        }
    }
}
