# Privacy and data handling

Hermes Android is a client. It does not provide a Gateway or account service.
You choose the Gateway URL and credentials in the app.

- **Connection data:** the configured Gateway receives the API, WebSocket,
  chat and attachment data required to provide Hermes features. The Gateway
  operator controls server-side logging and retention.
- **Credentials:** connection tokens are encrypted at rest with Android
  Keystore-backed AES-GCM. Password/cookie authentication uses origin-scoped
  session cookies for the configured Gateway. Removing the last connection for
  an origin clears its stored Gateway session and that origin's WebView storage;
  another connection to the same origin keeps the shared session. App-level
  cached chat data may remain until you clear the app's data in Android settings.
- **Notifications:** previews are off by default and can be enabled in More →
  Notifications. Lock-screen notifications use generic text even when previews
  are enabled in the app.
- **Attachments:** selected files are made available to the renderer and are
  sent only when the user submits them to a conversation. Review file contents
  before sending.
- **Microphone:** Android declares the audio permission for voice input. The
  app accepts audio-capture requests only from its own application origin and
  requests Android permission when needed;
  the user can deny it in Android settings. Voice audio and transcription may
  be processed by the renderer's configured speech service or the connected
  Gateway, depending on the renderer version and configuration.
- **External links:** non-app links open through Android's external URL
  handler. The destination then applies its own privacy policy.
- **Diagnostics:** Debug builds write app and renderer diagnostics to Android
  logcat; these may include URLs and error details. Release builds do not write
  these app diagnostics. Review and redact Debug logs before sharing them.

This notice describes the client code in this repository. It is not a promise
about data handling by a Gateway, model provider, or linked service. App store
distribution should include a maintainer contact and a review of the exact
release build's network behavior.
