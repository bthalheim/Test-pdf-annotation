package com.example.pdfannotation

import android.util.AtomicFile
import java.io.File

/**
 * Persists annotation JSON (one file per document) in app-private storage.
 * The JSON format is owned by the viewer (see assets/viewer/viewer.js).
 */
class AnnotationStore(private val dir: File) {

    @Synchronized
    fun load(docId: String): String? {
        val file = fileFor(docId) ?: return null
        if (!file.baseFile.exists()) return null
        return file.readFully().toString(Charsets.UTF_8)
    }

    @Synchronized
    fun save(docId: String, json: String) {
        val file = fileFor(docId) ?: return
        dir.mkdirs()
        val out = file.startWrite()
        try {
            out.write(json.toByteArray(Charsets.UTF_8))
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    private fun fileFor(docId: String): AtomicFile? {
        if (!ID_PATTERN.matches(docId)) return null
        return AtomicFile(File(dir, "$docId.json"))
    }

    private companion object {
        val ID_PATTERN = Regex("[A-Za-z0-9_-]{1,128}")
    }
}
