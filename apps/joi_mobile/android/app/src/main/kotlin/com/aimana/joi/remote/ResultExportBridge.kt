package com.aimana.joi.remote

import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import java.io.File
import java.util.concurrent.Executors

/** Only copies app-owned temporary exports; never accepts arbitrary destinations. */
class ResultExportBridge(private val activity: Activity) : MethodChannel.MethodCallHandler {
    private val prefs = activity.getSharedPreferences("result_exports", 0)
    private val worker = Executors.newSingleThreadExecutor()
    private var pending: Pair<MethodCall, MethodChannel.Result>? = null
    private var busy = false
    companion object { const val PICK_DIRECTORY = 8723 }

    init {
        // Remove only URIs journaled by an interrupted, unpublished operation.
        worker.execute {
            prefs.all.filterKeys { it.startsWith("pending:") }.forEach { (key, value) ->
                cleanup(value as? String ?: "[]")
                prefs.edit().remove(key).commit()
            }
        }
    }
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method == "open") {
            val id = call.argument<String>("id") ?: ""
            val data = prefs.getString("saved:$id", null)
            if (data == null) { result.success(false); return }
            try {
                val uri = Uri.parse(JSONArray(data).getString(0))
                val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, activity.contentResolver.getType(uri))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                intent.clipData = ClipData.newRawUri("Joi", uri)
                activity.startActivity(intent)
                result.success(true)
            } catch (_: Exception) { result.success(false) }
            return
        }
        if (call.method != "save") { result.notImplemented(); return }
        if (busy) { result.error("export_busy", "正在导出", null); return }
        busy = true
        if (Build.VERSION.SDK_INT < 29 && !validTree()) {
            pending = Pair(call, result)
            try {
                activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION), PICK_DIRECTORY)
            } catch (_: Exception) { pending = null; busy = false; result.error("export_directory_unavailable", "无法选择目录", null) }
        } else save(call, result)
    }
    private fun validTree(): Boolean {
        val saved = prefs.getString("tree", null) ?: return false
        if (!activity.contentResolver.persistedUriPermissions.any { it.uri.toString() == saved && it.isWritePermission }) return false
        return try {
            val tree = Uri.parse(saved)
            val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            activity.contentResolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { it.moveToFirst() } == true
        } catch (_: Exception) { false }
    }
    fun onActivityResult(request: Int, code: Int, data: Intent?): Boolean {
        if (request != PICK_DIRECTORY) return false
        val operation = pending ?: return true
        pending = null
        val uri = data?.data
        if (code != Activity.RESULT_OK || uri == null) {
            busy = false; operation.second.error("export_cancelled", "已取消", null); return true
        }
        try {
            activity.contentResolver.takePersistableUriPermission(uri, data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
            prefs.edit().putString("tree", uri.toString()).commit()
            save(operation.first, operation.second)
        } catch (_: Exception) { busy = false; operation.second.error("export_permission", "目录授权失败", null) }
        return true
    }
    private fun cleanup(json: String) {
        val values = JSONArray(json)
        for (i in 0 until values.length()) {
            try {
                val uri = Uri.parse(values.getString(i))
                if (DocumentsContract.isDocumentUri(activity, uri)) DocumentsContract.deleteDocument(activity.contentResolver, uri)
                else activity.contentResolver.delete(uri, null, null)
            } catch (_: Exception) { /* No contents or device paths enter logs. */ }
        }
    }
    private fun save(call: MethodCall, result: MethodChannel.Result) {
        worker.execute {
            val id = call.argument<String>("id") ?: ""
            val uris = JSONArray()
            try {
                require(Regex("[a-zA-Z0-9-]{1,100}").matches(id))
                val saved = prefs.getString("saved:$id", null)
                if (saved != null) {
                    activity.runOnUiThread { busy = false; result.success(mapOf("location" to if (Build.VERSION.SDK_INT >= 29) "下载/Joi" else "所选目录/Joi")) }
                    return@execute
                }
                val mime = call.argument<String>("mime") ?: ""
                require(mime == "application/pdf" || mime == "image/png")
                val paths = call.argument<List<String>>("paths") ?: emptyList()
                require(paths.isNotEmpty())
                val cache = activity.cacheDir.canonicalFile
                val inputs = paths.map { File(it).canonicalFile }
                inputs.forEach { require(it.path.startsWith(cache.path + File.separator) && it.isFile && it.parentFile?.name == "joi-export-$id") }
                val resolver = activity.contentResolver
                var treeDirectory: Uri? = null
                if (Build.VERSION.SDK_INT < 29) {
                    val tree = Uri.parse(prefs.getString("tree", null) ?: throw IllegalStateException())
                    val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
                    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
                    resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
                        while (cursor.moveToNext()) if (cursor.getString(1) == "Joi") treeDirectory = DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0))
                    }
                    if (treeDirectory == null) treeDirectory = DocumentsContract.createDocument(resolver, doc, DocumentsContract.Document.MIME_TYPE_DIR, "Joi")
                    require(treeDirectory != null)
                }
                for (file in inputs) {
                    val uri = if (Build.VERSION.SDK_INT >= 29) {
                        resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
                            put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
                            put(MediaStore.MediaColumns.MIME_TYPE, mime)
                            put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Joi")
                            put(MediaStore.MediaColumns.IS_PENDING, 1)
                        })
                    } else DocumentsContract.createDocument(resolver, treeDirectory!!, mime, file.name)
                    require(uri != null)
                    uris.put(uri.toString())
                    check(prefs.edit().putString("pending:$id", uris.toString()).commit())
                    resolver.openOutputStream(uri, "w")!!.use { output -> file.inputStream().use { it.copyTo(output) } }
                }
                if (Build.VERSION.SDK_INT >= 29) for (i in 0 until uris.length()) {
                    check(resolver.update(Uri.parse(uris.getString(i)), ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) == 1)
                }
                check(prefs.edit().putString("saved:$id", uris.toString()).remove("pending:$id").commit())
                activity.runOnUiThread { busy = false; result.success(mapOf("location" to if (Build.VERSION.SDK_INT >= 29) "下载/Joi" else "所选目录/Joi")) }
            } catch (_: Exception) {
                cleanup(uris.toString())
                val editor = prefs.edit().remove("pending:$id")
                if (Build.VERSION.SDK_INT < 29 && !validTree()) editor.remove("tree")
                editor.commit()
                activity.runOnUiThread { busy = false; result.error("export_save_failed", "保存失败，请检查空间和目录授权", null) }
            }
        }
    }
}
