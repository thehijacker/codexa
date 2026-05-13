# Keep JS interface methods so they are not stripped by R8/ProGuard
-keepclassmembers class com.codexa.reader.MainActivity$JsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
