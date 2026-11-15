# dsh-host-deepseek-chat-import

English | [中文](README.zh.md)

Imports a DeepSeek chat export (chat.deepseek.com `deepseek_data-*.zip`) uploaded by the browser into a chosen Workspace as archival Sessions.

## Model

- The browser POSTs the ZIP to the fixed `/api/deepseek-chat-import/archive` route (served by the API proxy when this plugin is composed); the body is buffered in memory — never written to disk — and answered with `application/x-ndjson` progress lines and one outcome line. One single import slot serves one upload at a time; the `limits` Remote reports the upload ceiling under `harniverse.operate`.
- `fflate` reads the archive: the central directory first, then one streaming pass stores the images of every chosen conversation (through the attachments seam) and a second settles each chosen conversation as its entry arrives. Budgets default to 1000 Sessions, a 512 MiB upload, a 256 MiB entry, and 80-byte titles; the export index's most-recently-updated order selects which conversations import.
- Each conversation converts through the pure reader (`conversation.ts`: branch selection by `current_message_id`, THINK/RESPONSE/SEARCH/OPEN fragments into steps, `web_search`/`web_fetch` tool-call replay) and settles through `session-import`'s `settleConverted` entry: the `deepseek-chat-v3` marker, content-derived identity under the conversation's lineage prefix (so re-importing the same conversation reports as already imported and a grown one continues through `session.continueArchive`), source retention beside the mapped log, and the never-resumable archival posture.
- The 会话导入 settings section gains the export entry: a file field plus the section's existing workspace target; a source-cwd target asks for a workspace first.

## Known Limitations and Deferred Work

- The whole archive is held in memory while it is imported; the upload ceiling bounds it.
- Images of conversations that later fail conversion stay stored; the attachment seam offers no removal.
