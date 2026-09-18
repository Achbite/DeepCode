# Connections, models and usage

Settings → Models and services groups **API connections** and **Coding Plans**. A connection owns its endpoint and credential reference; model profiles point to it and retain independent model and context settings. Connection details open directly into configuration. Saving one model leaves the others intact. The model last used for a submitted task remains the default for new conversations. Reasoning effort is chosen in the conversation selector and remembered per model; new conversations inherit that choice. A running request keeps its captured connection/model configuration.

Coding Plan is a service category. The first adapter is OpenAI Codex. DeepCode implements browser PKCE and device-code authentication through the Host, independent of an installed Codex CLI. Credentials stay in the existing local secret store. The GUI receives account labels and flow state; cancelling or leaving authentication releases the flow. Logout removes that connection's credential and cancels its login. Requests use the subscription's dedicated Responses transport, while API keys use the API connection's endpoint.

Quota is a timestamped response from the provider, not an estimate from local tokens. Its windows retain the supplied reset time and used percentage. A failed refresh displays its error. Subscription fees and subscription usage are not counted as metered API cost.

## Usage

The default interval is **the last 30 days**, including today and the previous 29 local dates. The daily chart can drill into hourly usage; today and seven-day ranges are also available. It is not a calendar-month report.

The Host indexes physical Provider calls with connection, model, Session, run and attempt attribution. Repeated stream observations update one call, including usage reported before interruption. Missing usage and unrecognized prices remain unavailable or partial. The report includes its recording start; earlier dates are not fabricated as zero consumption. This is a reporting index, not another Session journal or reducer.

The first price catalog covers the reviewed OpenAI API models. Each call keeps the applicable official price snapshot, returned model, service tier and long-context rule. The current source is [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Unknown cache-write usage does not silently become zero. The display is an estimate of model tokens and excludes additional provider tool charges, taxes and subscription fees. Other adapters expose tokens and calls until they have a verified price adapter.

Session cost details are optional via `settings.usage.panel` and the read-only usage port. Core Session token/context indicators remain available. See [UI plugins](ui-plugins.md).

## CLI and TUI

```sh
deepcode-cli connections
deepcode-cli auth login openai-codex browser
deepcode-cli auth login <connection-id> device
deepcode-cli auth status
deepcode-cli auth logout <connection-id>
deepcode-cli quota <connection-id>
deepcode-cli usage all 30
deepcode-cli --model <profile-id> ask "Explain this code."
```

CLI usage ranges use UTC dates explicitly. GUI queries send the local IANA timezone. TUI `/model` or `/connection` opens connection selection, then its enabled models. Arrow keys move, Enter selects, and Escape returns. `/model <profile-id>` selects directly. The shared Host owns configuration and authentication for both shells.

## Image attachments

Attach PNG, JPEG, WebP or GIF through the existing Files and folders control, or use CLI `--file`. The Host snapshots the file read-only. Session carries its image reference alongside the message; the Provider boundary resolves bytes into Responses `input_image`, Chat Completions `image_url`, Anthropic image blocks or Ollama images. The journal retains references, not base64 payloads. Input snapshots are never made writable to obtain vision support.

The built-in DeepSeek Flash and GPT-6 Astra presets declare image input. Other/custom models can explicitly enable it under the model's advanced settings when supported by the service. An unsupported model reports an error instead of silently receiving filenames as images. The current local image read limit is 8 MiB per image. The request size limit includes the encoded image data.

Service adapters are currently built-in registrations. External Provider process loading and GLM Coding Plan authentication remain the next separately planned stage; display/plugin ports do not grant Provider execution or Kernel permission authority.
