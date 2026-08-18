package io.metamask.devicemcp.snapshothelper;

/**
 * Retries a capture attempt until it is structurally complete, rather than
 * waiting for the accessibility event stream to go idle.
 *
 * <p>This is the core replacement for `uiautomator dump`'s {@code waitForIdle}
 * tax: on a screen that emits a continuous accessibility-event stream (e.g. a
 * React Native polling loop) the stream never quiesces, so idle-waiting fails.
 * Instead we optimistically capture immediately, check whether the result has
 * the roots we expect, and only re-attempt the (cheap) capture if not.
 */
final class AccessibilityCaptureStabilizer {

  private static final long RETRY_INTERVAL_MS = 50;

  interface Capture {
    boolean isComplete();
  }

  interface Attempt<T extends Capture> {
    T capture();
  }

  interface Clock {
    long nowMs();
  }

  interface Sleeper {
    void sleep(long millis) throws InterruptedException;
  }

  /** Thrown when no complete capture was produced within the timeout. */
  static final class IncompleteCaptureException extends Exception {
    IncompleteCaptureException(long timeoutMs) {
      super("Capture did not stabilize within " + timeoutMs + "ms");
    }
  }

  private AccessibilityCaptureStabilizer() {}

  static boolean requiresActiveWindowFallback(int capturedWindowCount, boolean activeWindowRootMissing) {
    return capturedWindowCount == 0 || activeWindowRootMissing;
  }

  static boolean canAppendActiveWindowFallback(
      int capturedWindowCount, boolean activeWindowMetadataAvailable) {
    return capturedWindowCount == 0 || activeWindowMetadataAvailable;
  }

  static <T extends Capture> T capture(Attempt<T> attempt, long timeoutMs)
      throws InterruptedException, IncompleteCaptureException {
    return capture(attempt, timeoutMs, System::currentTimeMillis, Thread::sleep);
  }

  static <T extends Capture> T capture(
      Attempt<T> attempt, long timeoutMs, Clock clock, Sleeper sleeper)
      throws InterruptedException, IncompleteCaptureException {
    T capture = attempt.capture();
    if (capture.isComplete()) {
      return capture;
    }
    if (timeoutMs <= 0) {
      throw new IncompleteCaptureException(timeoutMs);
    }

    long startedAtMs = clock.nowMs();
    long deadlineMs = startedAtMs + timeoutMs;
    if (deadlineMs < startedAtMs) {
      // Overflow guard.
      deadlineMs = Long.MAX_VALUE;
    }

    while (!capture.isComplete()) {
      long remainingMs = deadlineMs - clock.nowMs();
      if (remainingMs <= 0) {
        throw new IncompleteCaptureException(timeoutMs);
      }
      sleeper.sleep(Math.min(RETRY_INTERVAL_MS, remainingMs));
      capture = attempt.capture();
    }
    return capture;
  }
}
