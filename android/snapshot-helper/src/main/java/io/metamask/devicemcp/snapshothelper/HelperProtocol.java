package io.metamask.devicemcp.snapshothelper;

/**
 * Protocol and version constants shared between the instrumentation and the
 * host that parses its output.
 */
final class HelperProtocol {
  /** Literal emitted as {@code agentDeviceProtocol} in every status record. */
  static final String PROTOCOL = "device-mcp-snapshot-helper-v1";

  /** Bumped when the output contract changes in a host-incompatible way. */
  static final int HELPER_API_VERSION = 1;

  /** Output format label for the chunked hierarchy payload. */
  static final String OUTPUT_FORMAT = "uiautomator-xml";

  private HelperProtocol() {}
}
