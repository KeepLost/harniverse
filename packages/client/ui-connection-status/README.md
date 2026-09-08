# @deepseek-ai/dsh-client-ui-connection-status

English | [中文](README.zh.md)

Read-only Consumer of Connection's health projection. The plugin occupies `sidebar.header.status`, declared by [ui-sidebar](../ui-sidebar/README.md), between the expanded wordmark and collapse button. The collapsed rail places it below the combined logo/expand control.

The icon and its localized Tooltip distinguish connecting, connected, renewing, recovering, reconnecting, refresh-required, and explicit local bypass. Hover, keyboard focus, and touch focus expose the same explanation. There is no button, click action, authentication operation, polling, or renewal timer. Terminal authentication failure instructs the user to refresh and notes that a revoked device needs approval. Reduced-motion mode disables rotation.

Registration waits for the actual slot declaration. The framework binds the injected health observable; no UI store mirrors connection state. Unloading the renderer removes only its slot and dictionary contributions, never the authentication owner.

## Model Experience

None, as the icon consumes browser connection state only.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- The icon reports the latest confirmed connection/authentication state, not server health or model execution progress. Detailed transport diagnostics and manual recovery controls are outside this read-only surface.
