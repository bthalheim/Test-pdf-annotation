# Keep the methods exposed to JavaScript through addJavascriptInterface.
-keepclassmembers class com.example.pdfannotation.MainActivity$JsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
