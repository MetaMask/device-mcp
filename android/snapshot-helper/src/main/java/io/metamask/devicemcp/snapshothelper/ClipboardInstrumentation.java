package io.metamask.devicemcp.snapshothelper;

import android.app.Instrumentation;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.PersistableBundle;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Writes text to the device clipboard so an app's own Paste control can read it.
 *
 * <p>`cmd clipboard` has no shell implementation on recent Android images, and
 * background apps cannot write the clipboard. An instrumentation runs with the
 * permissions the clipboard service grants to test runners, so it can write
 * without being in the foreground.
 *
 * <p>The text arrives base64-encoded in the {@code textB64} argument so spaces
 * and shell metacharacters survive {@code am instrument -e}. The result never
 * contains the text: callers may be passing a secret recovery phrase. The clip
 * is marked sensitive so the Android 13+ copy overlay and keyboard suggestions
 * do not show it.
 */
public final class ClipboardInstrumentation extends Instrumentation {
  private static final String CLIP_LABEL = "device-mcp";

  // ClipDescription.EXTRA_IS_SENSITIVE: the constant is API 33, the key is
  // honored from API 33. Use the literal so the helper keeps minSdk 23.
  private static final String EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE";

  private Bundle arguments;

  @Override
  public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    this.arguments = arguments == null ? new Bundle() : arguments;
    start();
  }

  @Override
  public void onStart() {
    super.onStart();
    Bundle result = new Bundle();
    result.putString("agentDeviceProtocol", HelperProtocol.PROTOCOL);
    result.putInt("helperApiVersion", HelperProtocol.HELPER_API_VERSION);
    try {
      String encoded = arguments.getString("textB64");
      if (encoded == null) {
        throw new IllegalArgumentException("Missing textB64 argument");
      }
      final String text =
          new String(Base64.decode(encoded, Base64.DEFAULT), StandardCharsets.UTF_8);
      final Context context = getContext();
      final AtomicReference<Throwable> failure = new AtomicReference<>();
      // ClipboardManager must be used from a thread with a Looper.
      runOnMainSync(
          () -> {
            try {
              ClipboardManager clipboard =
                  (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
              if (clipboard == null) {
                throw new IllegalStateException("Clipboard service unavailable");
              }
              ClipData clip = ClipData.newPlainText(CLIP_LABEL, text);
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                // ClipDescription.setExtras is API 24.
                PersistableBundle extras = new PersistableBundle();
                extras.putBoolean(EXTRA_IS_SENSITIVE, true);
                clip.getDescription().setExtras(extras);
              }
              clipboard.setPrimaryClip(clip);
            } catch (Throwable error) {
              failure.set(error);
            }
          });
      if (failure.get() != null) {
        throw failure.get();
      }
      result.putString("ok", "true");
      result.putString("length", Integer.toString(text.length()));
    } catch (Throwable error) {
      // Report only the error type: a message could echo the input.
      result.putString("ok", "false");
      result.putString("errorType", error.getClass().getName());
    }
    finish(android.app.Activity.RESULT_OK, result);
  }
}
