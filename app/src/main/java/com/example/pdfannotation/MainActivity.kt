package com.example.pdfannotation

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * Hosts the PDF.js based viewer (assets/viewer) in a WebView.
 *
 * Everything is served from https://appassets.androidplatform.net via [WebViewAssetLoader]:
 *  - /assets/...           bundled assets (viewer UI, pdf.js, sample.pdf)
 *  - /document/<n>.pdf     the PDF the user opened (streamed from its content:// URI)
 *
 * The viewer talks back to the app through the `AndroidBridge` JavaScript interface to open
 * files and to load/save annotations.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var annotations: AnnotationStore

    /** The currently opened external document, served at [documentPath]. */
    @Volatile private var openDocument: OpenDocument? = null
    private var documentCounter = 0

    private val pickPdf = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) showDocument(uri)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        annotations = AnnotationStore(File(filesDir, "annotations"))

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/document/", DocumentPathHandler())
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
            }
            // Needed for window.confirm() and friends to show native dialogs.
            webChromeClient = WebChromeClient()
            addJavascriptInterface(JsBridge(), "AndroidBridge")
        }
        setContentView(webView)

        intent?.pdfUri()?.let { openDocument = describe(it) }
        webView.loadUrl(VIEWER_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.pdfUri()?.let { showDocument(it) }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun Intent.pdfUri(): Uri? = if (action == Intent.ACTION_VIEW) data else null

    /** Makes [uri] the current document and tells the viewer to display it. */
    private fun showDocument(uri: Uri) {
        val doc = describe(uri)
        openDocument = doc
        webView.evaluateJavascript("window.viewer && window.viewer.openDocument(${doc.toJson()});", null)
    }

    private fun describe(uri: Uri): OpenDocument {
        documentCounter += 1
        val name = runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull() ?: uri.lastPathSegment ?: "document.pdf"
        return OpenDocument(
            uri = uri,
            path = "doc-$documentCounter.pdf",
            id = sha256(uri.toString()),
            name = name,
        )
    }

    private data class OpenDocument(val uri: Uri, val path: String, val id: String, val name: String) {
        fun toJson(): String = JSONObject()
            .put("url", "$DOCUMENT_BASE$path")
            .put("id", id)
            .put("name", name)
            .toString()
    }

    /** Streams the current document from its content URI. Runs on a WebView background thread. */
    private inner class DocumentPathHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val doc = openDocument ?: return null
            if (path != doc.path) return null
            return try {
                val stream = contentResolver.openInputStream(doc.uri) ?: return null
                WebResourceResponse("application/pdf", null, stream)
            } catch (e: Exception) {
                Log.w(TAG, "Unable to open ${doc.uri}", e)
                null
            }
        }
    }

    /** Methods callable from JavaScript as `AndroidBridge.*`. Invoked on a background thread. */
    inner class JsBridge {
        /** JSON for the document to show at startup, or "" to show the bundled sample. */
        @JavascriptInterface
        fun getInitialDocument(): String = openDocument?.toJson() ?: ""

        @JavascriptInterface
        fun openFilePicker() {
            runOnUiThread { pickPdf.launch(arrayOf("application/pdf")) }
        }

        @JavascriptInterface
        fun loadAnnotations(docId: String): String = annotations.load(docId) ?: ""

        @JavascriptInterface
        fun saveAnnotations(docId: String, json: String) {
            annotations.save(docId, json)
        }
    }

    companion object {
        private const val TAG = "PdfAnnotation"
        private const val HOST = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}"
        private const val VIEWER_URL = "$HOST/assets/viewer/index.html"
        private const val DOCUMENT_BASE = "$HOST/document/"

        private fun sha256(value: String): String =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
                .joinToString("") { "%02x".format(it) }
    }
}
