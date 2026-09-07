package io.metamask.devicemcp.snapshothelper;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;


/**
 * Bounds the {@code getUiAutomation()} connect step.
 *
 * <p>{@code Instrumentation.getUiAutomation()} can block internally for up to
 * ~60s connecting to the accessibility service on newer target SDKs and does
 * not respond to {@link Thread#interrupt()}. We run the connect attempt on a
 * daemon thread and enforce our own timeout via {@link FutureTask#get(long,
 * TimeUnit)}.
 */
final class BoundedUiAutomationConnection {

  private static final long RETRY_INTERVAL_MS = 50;

  /** Thrown when the connection could not be established within the timeout. */
  static final class TimeoutException extends Exception {
    TimeoutException(String message) {
      super(message);
    }
  }

  interface Attempt<T> {
    /** Returns the connection, or {@code null} if it is not ready yet. */
    T connect();
  }

  private BoundedUiAutomationConnection() {}

  static <T> T await(Attempt<T> attempt, long timeoutMs)
      throws InterruptedException, TimeoutException {
    FutureTask<T> task = new FutureTask<>(() -> connectWhenReady(attempt));
    Thread worker = new Thread(task, "device-mcp-ui-automation-connect");
    worker.setDaemon(true);
    worker.start();

    try {
      return task.get(Math.max(1, timeoutMs), TimeUnit.MILLISECONDS);
    } catch (java.util.concurrent.TimeoutException error) {
      task.cancel(true);
      throw new TimeoutException("Timed out waiting for Android UiAutomation to connect");
    } catch (InterruptedException error) {
      task.cancel(true);
      Thread.currentThread().interrupt();
      throw error;
    } catch (ExecutionException error) {
      Throwable cause = error.getCause();
      if (cause instanceof RuntimeException) {
        throw (RuntimeException) cause;
      }
      if (cause instanceof Error) {
        throw (Error) cause;
      }
      throw new IllegalStateException("Android UiAutomation connection failed", cause);
    }
  }

  private static <T> T connectWhenReady(Attempt<T> attempt) throws InterruptedException {
    while (true) {
      T connection = attempt.connect();
      if (connection != null) {
        return connection;
      }
      Thread.sleep(RETRY_INTERVAL_MS);
    }
  }
}
