# 07 — Dictation

Two halves. **Part 1** is the OpenAI transcription contract, verified against OpenAI's own
current documentation rather than blog summaries. **Part 2** is the voice-input experience,
researched against Apple's published guidance, the App Store Review Guidelines, WCAG, and the
documented behaviour of mature products. **Part 3** is the board that implements it.

Companion board: **`15 — Components · Dictation`** in *AI Whiteboard Tutor — Design System,
Components & Page*, at worldY 2400 in the documentation row.

Everything marked **(a)** is documented guidance quoted from a primary source, **(b)** is
documented product behaviour, **(c)** is inference. The distinction is load-bearing — several
widely-repeated claims about this problem turn out to have no primary source at all, and they
are called out below rather than quietly reused.

---

# Part 1 — The API

## 1. The endpoint

`POST https://api.openai.com/v1/audio/transcriptions`, `multipart/form-data`.

Source: [Speech to text guide](https://developers.openai.com/api/docs/guides/speech-to-text) ·
[Audio API reference](https://developers.openai.com/api/reference/resources/audio)

### 1.1 Parameters

| Parameter | Required | Notes |
| --- | --- | --- |
| `file` | **yes** | The audio. Container is inferred from the filename *and* the part's `Content-Type` — both must agree. |
| `model` | **yes** | `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, `whisper-1`. |
| `prompt` | no | "unstructured context about the recording". Improves "recognition of names, acronyms, formatting, or recording-specific vocabulary". **224-token limit on `whisper-1` only**; no stated limit for `gpt-transcribe`. |
| `keywords` | no | Array. "Literal terms you expect to hear." **`gpt-transcribe` only.** |
| `languages` | no | Array of ISO 639-1 (`en`), selected ISO 639-3, or regional `zh` codes. **Replaces the singular `language` field.** `gpt-transcribe` only. |
| `response_format` | no | `json` · `text` · `verbose_json` · `diarized_json`. |
| `stream` | no | Boolean. See §1.2. |
| `include[]` | no | `logprobs`. |
| `timestamp_granularities[]` | no | `word` / `segment`. **`whisper-1` only** — not available on `gpt-transcribe`. |
| `chunking_strategy` | no | `auto` or a VAD config. For audio over 30 s **with diarization**. |
| `known_speaker_names[]` / `known_speaker_references[]` | no | Diarization only. Up to 4 speakers, 2–10 s of reference audio each as data URLs. |

**Hard rejection rule, verbatim:** *"Keep each keyword on one line and don't include `<`, `>`, a
carriage return, or a line feed. The API rejects the entire request when it encounters one of
these characters or when `prompt` exceeds the model's length limit."* This is a **400 for the
whole request**, not a silently-ignored parameter. Any prompt assembled from a multi-line source
string must be checked for embedded newlines.

### 1.2 `stream=true` and the SSE sequence

Verbatim: *"File transcription can stream partial text while the model processes a completed
recording."* Note what this is and is not — it streams the **transcription** of an already-closed
recording. It does not stream during capture. The two phases in Part 2 are a property of file
transcription and `stream=true` only shortens the second one; it does not remove it.

Supported on `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and
`gpt-4o-transcribe-diarize`. **Not `whisper-1`.**

Events:

| Event | Payload | When |
| --- | --- | --- |
| `transcript.text.delta` | `{ type, delta: string, logprobs? }` | Partial text. Carries `segment_id` for diarized output. |
| `transcript.text.segment` | `{ type, id, start, end, text, speaker }` | Diarization model only, when a segment finalises. |
| `transcript.text.done` | `{ type, text: string, logprobs?, usage }` | Final. Carries the **whole** transcript and, for `gpt-transcribe`, the detected `languages`. |

**The deltas are appends, not revisions.** This is the single most important behavioural
difference from Apple's `SFSpeechRecognizer`, whose partial results each restate the entire
utterance. Code written against Apple's semantics that replaces the field on every callback will
show only the last fragment. Code written for OpenAI must concatenate.

**`transcript.text.done` is authoritative, not merely terminal.** It is punctuated and cased,
where the sum of the deltas need not be. Take its `text` over the accumulated string.

The stream is terminated by SSE `data: [DONE]`. A stream that ends without `transcript.text.done`
is a truncated stream and must be treated as a failure, not as a short transcript.

### 1.3 Audio

**Accepted:** `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`.

**Limit:** *"Files can be up to 25 MB."* Over that: *"Split the file into chunks of 25 MB or less.
Avoid splitting in the middle of a sentence."*

**OpenAI publishes no sample-rate or bit-rate recommendation for the file endpoint.** (a) The
[Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)
specifies 24 kHz base64 PCM16 — but that is the *Realtime* contract and does not transfer.

**(c) What minimises upload latency**, and the reasoning:

- Speech is fully intelligible at **16 kHz**; the models are trained on 16 kHz-band audio and
  nothing above 8 kHz carries phonetic information.
- **Mono.** A second channel doubles the bytes and adds nothing.
- **16 kHz mono PCM16 = 32 kB/s.** A 60-second utterance is 1.92 MB — 8 % of the 25 MB ceiling.
  Duration is not the binding constraint; nothing a student says in one breath will approach it.
- Uncompressed WAV beats compressed formats here. Encoding to AAC/Opus costs CPU time *before*
  the upload starts, and at these sizes the transfer saving does not repay it on a warm
  connection. Send raw PCM16 in a WAV container.
- **Write the WAV header incrementally as you capture**, so the file is complete the instant the
  student stops. Serialising the whole buffer after the stop tap adds a visible pause to the
  phase that is already the slow one.

### 1.4 Model choice — `gpt-transcribe` is correct

Pricing, from [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing):

| Model | Price | Prompt | `keywords` | Streaming | Notes |
| --- | --- | --- | --- | --- | --- |
| **`gpt-transcribe`** | **$0.0045 / min** | ✔ | ✔ | ✔ | *"the recommended model for transcribing recorded speech in its original language"* |
| `gpt-4o-mini-transcribe` | $0.003 / min | ✔ (legacy) | ✘ | ✔ | Cheapest. No `keywords`. |
| `gpt-4o-transcribe` | $0.006 / min | ✔ (legacy) | ✘ | ✔ | Costs more than the recommended model. |
| `gpt-4o-transcribe-diarize` | $0.006 / min | ✘ | ✘ | ✔ | Speaker labels. Irrelevant — one speaker. |
| `whisper-1` | $0.006 / min | ✔ (224 tok) | ✘ | ✘ | Translation-to-English and word timestamps only. |
| `gpt-live-transcribe` | $0.017 / min | ✔ | ✔ | Realtime | WebSocket / WebRTC. |

**Confirmed: `gpt-transcribe`.** Four reasons, in order of weight:

1. It is the only model in the file-transcription set that accepts **`keywords`**, and maths
   vocabulary steering is the difference between a usable feature and an unusable one (§1.5).
2. It is OpenAI's stated recommendation for exactly this job.
3. It is **cheaper than every alternative except the mini model**, which cannot take `keywords`.
   `gpt-4o-transcribe` and `whisper-1` both cost more *and* do less.
4. It returns detected `languages`, which `gpt-4o-*-transcribe` does not.

**The one honest challenge** is `gpt-4o-mini-transcribe` at $0.003/min — 33 % cheaper. Reject it.
At realistic volume the saving is meaningless: a 20-second question costs **$0.0015** on
`gpt-transcribe` and $0.001 on mini. A hundred dictated questions a day for a year is $55 versus
$36. Nineteen dollars a year does not buy back "solve for eggs".

**What `gpt-live-transcribe` ($0.017/min, ~3.8× the cost) would buy:**

- **The capture/transcribe split disappears.** Text arrives *while the student is speaking*, so
  there is one phase, not two, and the wait after the stop tap goes to roughly zero.
- A tunable latency floor: `audio.input.transcription.delay` takes `minimal` · `low` · `medium` ·
  `high` · `xhigh`, and the guide suggests starting at `low` for live captions.
- Server-side VAD that can commit turns automatically.

**What it costs beyond money:** a persistent WebSocket (reconnection, backgrounding, and network
transitions all become your problem), a 24 kHz PCM16 base64 pipeline instead of one file upload,
and — verbatim — *"`gpt-live-transcribe` doesn't return word-level timestamps, speaker labels, or
transcription confidence scores."* Ordering between completion events across turns is also *"not
guaranteed"*.

**Recommendation: stay on `gpt-transcribe`.** But note the design consequence honestly — the
two-phase experience in Part 2 exists *because* of this choice. If the transcribe wait ever
measures badly with real students, the fix is a model change, not more animation.

### 1.5 The `prompt` parameter, and the recommended maths prompt

**How it actually works.** `prompt` is *"unstructured context about the recording"*. It is not an
instruction to the model and not a grammar — it biases the decoder's priors. OpenAI's documented
use cases are exactly ours:

- *"Correctly transcribing product names, technical terms, and acronyms"*
- *"Carrying context from a previous chunk of a longer recording"*
- *"Preserving punctuation, capitalization, and filler words"*
- *"Selecting a preferred writing system for a language"*

**`keywords` is the better instrument for a term list**, and it is what the current build is
missing. The guide separates them deliberately: `keywords` for *"literal terms you expect to
hear"*, `prompt` for the situation. It also warns that *"keywords are hints, not required
output"* and recommends *"including only relevant terms"* after evaluating their effect.

**Why this matters more here than almost anywhere.** Both of our inputs are worst cases in the
ASR literature, at once:

- **Children's speech.** [Kid-Whisper (arXiv:2309.07927, AIES 2024)](https://arxiv.org/abs/2309.07927)
  measures *"the WER for the scripted part of CSLU Kids is between 6 and 10 times that of
  Librispeech, and the WER for MyST is between 3 and 5 times"*.
- **Mathematical language.** [MathSpeech (arXiv:2412.15655, AAAI 2025)](https://arxiv.org/abs/2412.15655)
  reports ASR producing *"a verbose and error-prone textual description (e.g., e to the power of
  i x equals cosine of x plus **i side of x**)"* — the error is in the paper's own abstract.

And a category of error no prompt can fix: **"one over x plus two" is irreducibly ambiguous.**
No recogniser can decide whether that is `1/(x+2)` or `1/x + 2`. Only the student can. This is a
second, independent reason the transcript must land in an editable field (§2.6).

**Recommended configuration.** Split the current single blob:

```
prompt:    "A student is thinking out loud about a maths problem for a tutor.
            Numbers and operations are spoken in words, not symbols."

languages: ["en"]

keywords:  sine, cosine, tangent, theta, pi, squared, cubed, square root,
           radical, radicand, exponent, power, numerator, denominator,
           fraction, decimal, percent, ratio, equation, inequality,
           expression, coefficient, variable, constant, integer, factor,
           factorise, simplify, substitute, expand, solve for x, quotient,
           remainder, absolute value, logarithm, polynomial, quadratic,
           binomial, vertex, slope, intercept, axis, origin, coordinate,
           vector, angle, degrees, radians, hypotenuse, isosceles,
           perpendicular, parallel, congruent, perimeter, circumference,
           diameter, radius, area, volume, plus, minus, times, divided by,
           equals, negative, over, therefore
```

Rules that follow from the documentation:

- **One keyword per line, and never `<`, `>`, CR or LF inside one.** The API rejects the whole
  request otherwise.
- **Keep `prompt` short.** It is prepended to the model's context on every request; a long one
  starts shaping the *wording* of the transcript rather than its spelling.
- **Set `languages: ["en"]`.** Without it the model must detect, and a mispredicted language on a
  four-word utterance is a total loss. The docs note that an unreliable prediction returns
  `"languages": []`.
- Evaluate the keyword list against real recordings and **prune it**. The docs are explicit that
  more terms is not better.

### 1.6 Failure modes

Sources: [Error codes](https://developers.openai.com/api/docs/guides/error-codes) ·
[Rate limits](https://developers.openai.com/api/docs/guides/rate-limits)

| Condition | What comes back | Handling |
| --- | --- | --- |
| Bad / revoked / wrong-org key | **401** | Not a dictation failure — it is the key. Route to board 14's `state/error · auth`, not to the composer. |
| Unsupported region | **403** | Same auth-shaped surface. |
| Malformed request — bad `prompt` chars, `keywords` with a newline, unsupported container | **400** `BadRequestError` | A **bug**, not a runtime condition. Assert on it in tests; never show it to a student. |
| Payload over 25 MB | **413** | Unreachable at a 60 s cap and 16 kHz mono, but guard anyway. |
| Too many requests | **429** `rate_limit_exceeded` | *"Pace your requests and follow the `Retry-After` header when it's present."* Exponential backoff with jitter otherwise. |
| Credits gone / spend limit | **429** `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded` | **Do not retry.** Retrying a billing error is pure latency. |
| Server fault | **500** | *"Retry your request after a brief wait."* |
| Overloaded / traffic spike | **503** — "Engine overloaded", "Slow Down" | Retry after a wait. For *Slow Down*: *"reduce your request rate to its original level, maintain a consistent rate for at least 15 minutes, and then gradually increase it."* |
| Network / TLS / firewall | `APIConnectionError` | Retry once, then the composer's error line. |
| Client timeout | `APITimeoutError` | Same. |
| **Truncated stream** | 200, then EOF with no `transcript.text.done` | **Must be a failure.** Silently accepting the partial text hands the student a half-sentence they may not notice. |
| **Silent or empty audio** | **200** with `text: ""` — *or worse, see below* | Not an error. §2.9. |

**Rate-limit headers, exact names:** `x-ratelimit-limit-requests`,
`x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`,
`x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`, `x-ratelimit-limit-project-tokens`,
`x-ratelimit-remaining-project-tokens`, and `Retry-After` — *"the minimum number of seconds to
wait before retrying a temporary rate-limit error."*

The audio endpoints are metered in **audio minutes per minute** for some streaming audio models,
alongside the usual RPM/TPM.

**Empty audio is more dangerous than it looks.** ["Careless Whisper" (Koenecke et al., ACM FAccT
'24)](https://dl.acm.org/doi/10.1145/3630106.3658996) found *"roughly 1% of audio transcriptions
contained entire hallucinated phrases or sentences which did not exist in any form in the
underlying audio"*, that *"38% of hallucinations include explicit harms"*, and — the mechanism
that matters here — that hallucinations *"disproportionately occur for individuals who speak with
longer shares of non-vocal durations."* OpenAI's own
[Whisper model card](https://github.com/openai/whisper/blob/main/model-card.md) concedes *"the
predictions may include texts that are not actually spoken in the audio input."*

**(c) `transcript.isEmpty` is therefore not a sufficient guard.** A child who taps the mic,
hesitates, and taps again can plausibly receive `"Thank you."` — grammatical, confident, and
entirely fabricated. The client-side defence that works without pipeline changes is the one the
design already requires: **the text lands in the composer where the student reads it before it is
sent.**

### 1.7 Latency — does the UI need a "transcribing" phase?

**Yes.** OpenAI publishes no latency figure for the file endpoint, so this is reasoned rather than
quoted, and should be measured against real devices.

A short utterance's round trip is the sum of: request setup and TLS on a warm connection
(~50–150 ms), upload of roughly 0.3–1 MB on typical school Wi-Fi (~100–500 ms), model
processing, and first-byte return. **Realistically 1–3 seconds**, which lands squarely in the
band that demands an indicator: Nielsen's thresholds put **1.0 s** as *"the limit for the user's
flow of thought to stay uninterrupted"*
([NN/g](https://www.nngroup.com/articles/response-times-3-important-limits/)), and NN/g's
progress-indicator guidance says to *"use a progress indicator for any action that takes longer
than about 1.0 second"*, with a looped animation *"reserved for actions that take between 2-10
seconds"* ([NN/g](https://www.nngroup.com/articles/progress-indicators/)).

`stream=true` shortens the *perceived* wait considerably — the first
`transcript.text.delta` arrives well before the transcript completes — but it does not remove the
gap between the stop tap and the first delta. **The transcribing phase must be designed, not
treated as instant.**

---

# Part 2 — The experience

## 2.1 What Apple actually says — and what it does not

**There is no Human Interface Guidelines page on microphones, voice input, dictation, or Live
Speech.** (a) The HIG Inputs hub covers Action button, Apple Pencil, Camera Control, Digital
Crown, Eyes, Focus, Game controls, Gestures, Gyroscope, Keyboards, Nearby interactions, Pointing
devices and Remotes. `speech`, `dictation` and `live-speech` all 404. Any claim that "the HIG
says X about mic buttons" is unsupportable, and this document does not make one.

The governing Apple guidance is elsewhere, and it is quite specific:

**[`SFSpeechRecognizer`](https://developer.apple.com/documentation/speech/sfspeechrecognizer)**,
under *"Create a great user experience for speech recognition"* — (a):

- *"Remind the user when your app is recording."*
- *"display a visual indicator and play sounds at the beginning and end of speech recognition"*
- *"You can also display speech as it is being recognized so that users understand what your app
  is doing and see any mistakes"*
- *"Plan for a one-minute limit on audio duration."* — *"This limit is similar to the one for
  keyboard-related dictation."*

**[Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)** — (a):

- *"Keep progress indicators moving so people know something is continuing to happen."*
- *"People tend to associate a stationary indicator with a stalled process or a frozen app."*
- *"Avoid vague terms like loading or authenticating because they seldom add value."*
- *"Don't switch from the circular style to the bar style."*
- *"When it's feasible, let people halt processing."*

**[Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)** — (a):
*"Warn people when they initiate a task that can cause data loss that's unexpected and
irreversible. In contrast, don't warn people when data loss is the expected result of their
action."*

**[Playing audio](https://developer.apple.com/design/human-interface-guidelines/playing-audio)** —
(a), and iPad-specific: closing the Smart Folio mutes the microphone, and restarting the session
on reopen *"risks invading people's privacy by unmuting the microphone without their knowledge."*
Also, the `record` category *"doesn't respond to the silence switch"* — start/stop earcons will
sound even on a silenced iPad.

**One correction worth recording.** The widely-quoted line *"don't display inaccurate progress
information just to make your app appear busy"* is **not** on the current HIG page. It is legacy
pre-2023 text. Do not cite it — even though it happens to describe exactly what §2.3 argues.

## 2.2 Toggle, not hold-to-talk

**Decision: tap to start, tap to stop.** Hold-to-talk is not offered, at either scale.

**The evidence, strongest first:**

**Apple's own two voice surfaces both use tap-toggle, and offer hold only as an accelerator.**

- [Keyboard dictation](https://support.apple.com/guide/ipad/dictate-text-ipad997d9642/ipados)
  (b): *"Tap [mic] on the onscreen keyboard… begin to dictate your text"*; *"When you're done, tap
  [icon] or say 'stop dictation.'"* Note the second, non-pointer stop path.
- [Messages audio](https://support.apple.com/guide/iphone/send-and-receive-audio-messages-iph2e42d3117/ios)
  (b): *"Tap Audio, then begin speaking"*, then *"Tap to pause or end your recording"* followed by
  **Send it / Listen to review it / Add to the end of it / Cancel it**. Hold appears only as a
  tip: *"Send follow-up audio messages more quickly by touching and holding in the text field."*

**Telegram documented the ergonomic problem in its own release notes** —
[Video messages and Telescope, 2017](https://telegram.org/blog/video-messages-and-telescope) (b):
*"If holding the button seems like too much work, you can lock the camera in recording mode by
swiping up. This also works with voice messages now."* Every product that shipped hold-only has
since added a lock escape hatch, and WhatsApp provides a real **CANCEL button** once locked —
i.e. even the hold-first products fall back to buttons for the sustained case.

**The accessibility argument is the one that closes it, and the commonly-cited SC is the wrong
one.** WCAG **2.5.2 Pointer Cancellation** does *not* rule out hold-to-talk: its down-event only
*starts* recording, so it passes via the Abort-or-Undo option. The success criterion that
actually bites is **[2.1.1 Keyboard (Level A)](https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html)**
— *"operable through a keyboard interface **without requiring specific timings for individual
keystrokes**"*, whose Understanding document names as a failure the case *"where a key must be
held down for an extended period before the keystroke is registered."* On iPad that covers
hardware keyboards, Full Keyboard Access, and Switch Control.

**And VoiceOver has no variable-duration press at all.** (a) The
[iPad VoiceOver gestures list](https://support.apple.com/guide/ipad/use-voiceover-gestures-ipad9a246584/ipados)
maps *"Touch and hold (long press) the item"* to **triple tap** — a discrete event. A
hold-to-talk button would start and instantly stop. The only sustained-press route is the
pass-through ritual (*"Double-tap and hold your finger on the screen until you hear three rising
tones"*).

**Voice Control** (a) issues discrete commands (*"say a command—such as 'Long press'"*), and
**(c)** the user is speaking into the microphone they just opened, so hold-to-talk is effectively
unusable there.

**(c) And the product reason:** this student is holding an Apple Pencil in the other hand and is
thinking aloud in sentences long enough that a held finger becomes the thing they are
concentrating on.

## 2.3 What "listening" must show

**The current build reuses `state/thinking`'s three animated dots. That is not enough, and after
the API swap it becomes actively dishonest.**

The dots run on a fixed 1.2 s loop whether or not the microphone hears anything. With Apple's
recogniser that was survivable, because words appeared in the field as the student spoke and the
words were the real evidence. **File transcription removes the words.** The dots would then be
the *only* signal, and they would be a signal of nothing — identical for a working microphone, a
muted one, a Smart Folio closed over the mic array, and a student too far from the iPad.

**This is not only a taste question. App Store Review Guideline 2.5.14** (a),
[verbatim](https://developer.apple.com/app-store/review/guidelines/):

> "Apps must request explicit user consent and provide a clear visual and/or audible indication
> when recording, logging, or otherwise making a record of user activity. This includes any use of
> the device camera, microphone…"

**(c)** The system's orange dot does not discharge this — that is the OS's indicator; 2.5.14
obliges *the app*. And Apple's own `SFSpeechRecognizer` guidance says the same thing in product
terms: *"Remind the user when your app is recording"*, *"display a visual indicator and play
sounds at the beginning and end."*

**The minimum honest indicator** is something whose motion is *caused by* the microphone. **The
best** is a level meter driven by the live input amplitude, because it answers four questions at
once that a spinner answers none of: is it on, can it hear me, am I loud enough, and am I close
enough.

Supporting guidance:

- [Meta Horizon voice design](https://developers.meta.com/horizon/design/voice-technology/) (a) —
  the closest published statement of the intent: a visual cue helps the user *"gauge and calibrate
  the volume from their mic"*, and *"the **Mic on** status should be accurately represented on
  screen as soon as your app calls for audio input."*
- [Amazon Alexa baseline guidance](https://developer.amazon.com/en-US/alexa/voice-interoperability/design-guide/baseline-guidance)
  (a) — *"It is very important for a product to convey a device's Microphone On/Off state."*
- [NN/g, Visibility of system status](https://www.nngroup.com/articles/visibility-system-status/)
  (a) — *"systems should always keep users informed about what is going on"*, and *"the
  predictability of the interaction creates trust not only in the mechanics of the site or the
  app, but also in the brand itself."*

**Stated honestly: no published guideline says in so many words "drive the waveform from real
amplitude rather than animating it."** Meta's line is the closest. The rest is **(c)**.

**Apple's own dictation** puts its waveform *"near the insertion point in the text field"* (b) —
in context, adjacent to where the text will land, not remote. The design follows this: the meter
occupies the composer's text lane, standing exactly where the words will appear.

**The design.** `ui/level` — five bars, each 6 pt wide at panel scale, `--radius-full`,
`--color-icon`, gap `--spacing-2` 8. Bar height ranges from **6 pt (a circle — identical to a
`state/thinking` dot) to 25 pt (`--leading-body`, the line box the lane already occupies)**,
driven by the RMS of the live input buffer at ~20 Hz. At full-screen scale: bar 8, gap 12,
ceiling 30 (`--leading-lead`).

At silence the meter collapses to five motionless dots — which is the truth, and is exactly the
mark the system already uses for "something is happening but there is nothing to show."

## 2.4 Two phases, told apart by where the motion comes from

**Capturing** shows the meter and an elapsed timer. **No word.** The meter moving with the
student's voice *is* the message, and it says more than any label could.

**Transcribing** shows `state/thinking`'s three dots — unchanged, the house mark — plus the word
**"Transcribing…"**. Because there is genuinely nothing to see, a timer-driven animation is now
honest, and the word carries what the animation cannot.

**The asymmetry is the design.** Motion that answers you = listening. Motion that doesn't, plus a
word = working. A student never has to be taught the difference; they discover it the first time
they stop talking.

Supporting guidance:

- **Amazon's attention system** is the definitive published two-phase source (a),
  [invoking Alexa](https://developer.amazon.com/en-US/docs/alexa/alexa-auto/invoking-alexa.html):
  *Listening* *"starts when Alexa has been invoked… and the microphone begins streaming"*;
  *Thinking* — *"This state lets the customer know **the microphone is no longer active** and
  Alexa is processing their request."* And: *"For products with visual cues, it is required that
  these states are distinguishable from each other."*
- Amazon also requires an **end-of-request earcon**: *"This sound allows the customer to know your
  assistant has heard their request without looking at the screen."*
- Apple's *"avoid vague terms like loading"* argues for the specific word "Transcribing…" over a
  bare spinner.

**One tension recorded rather than hidden.** Apple's *"Don't switch from the circular style to the
bar style"* counsels against morphing an indicator mid-process. This design does change the mark
between phases — but the phases are genuinely different *states*, not stages of one operation, and
the two marks share a primitive (the 6 pt dot at `--radius-full` in `--color-icon`), so the change
reads as the same object at rest rather than as a different indicator.

## 2.5 The composer's row never changes shape

At panel scale the row is `[leading 24] [text lane] [voice 38] [send 42]`; at full screen
`[text lane] [voice 52] [send 56]`. **Every dictation state occupies those same slots.** Only the
contents of the text lane change:

| State | Leading | Text lane | Trailing |
| --- | --- | --- | --- |
| idle | marquee | placeholder | voice · send |
| requesting permission | *unchanged from idle — the app draws nothing* | | |
| capturing | `ui/cross` cancel | `ui/level` + elapsed | voice (= stop) · send |
| transcribing | `ui/cross` cancel | dots + "Transcribing…" | send |
| partial text | `ui/cross` cancel | text + `state/streaming` caret | send |
| empty result | marquee | placeholder, + note above the pill | voice · send |
| error | marquee | placeholder, + note above the pill | voice · send |
| denied | *board 14's error block above the composer* | | |
| unavailable | marquee | placeholder | **send only — no mic** |

The mic's geometry is untouched throughout: 38 × 38 with a 20 pt glyph at panel scale, 52 × 52
with 26 pt at full screen, no fill, no radius.

## 2.6 Correction and trust — the text goes in the composer, never straight out

**Every major text composer puts transcribed text in an editable field. None auto-sends.** (b) —
Apple dictation, Gboard, ChatGPT dictation, Otter, Google Recorder, Google Docs. Auto-send exists
only in eyes-free assistant contexts, is opt-in, and is scoped to Siri messaging (a):
*"Send messages without confirmation: Tap Messaging with Siri, then turn on Automatically Send
Messages."*

OpenAI describes its own dictation feature the same way (b),
[Voice dictation FAQ](https://help.openai.com/en/articles/12168547-voice-dictation-faq): *"Use
ChatGPT Dictation when you want to record a prompt, review and edit its transcription, and then
send it as text."*

**The research result that settles it.** [Karat et al., CHI '99](https://dl.acm.org/doi/10.1145/302979.303160)
(a) found that users *"were usually aware of when a typing error occurred, but were much less
confident of being aware of when a speech error occurred."* **(c) Users cannot self-monitor
speech errors. Visible text is the correction mechanism, not a nicety** — and our error profile
(§1.5) is far worse than that of the products which already decline to auto-send.

So:

- Text arrives in the composer, editable, with the caret at the end.
- **Dictation appends** after anything already typed, separated by a single space. It never
  replaces the field. A student who typed half a question and decided to say the rest loses
  nothing.
- Send is a separate, deliberate act — as it already is for typed text.
- With `stream=true`, deltas append live so the student can see "sine" come out as "sign" and stop
  before it goes.

## 2.7 Cancel

**The current build has no answer. The design adds one: a discrete, tappable cancel in the
composer's leading slot.**

`ui/cross` at 22 × 22 (stroke 2.18 → 2.00 effective) in `--color-icon` at panel scale; 26 × 26
(stroke 1.85) at full screen. It occupies the marquee slot, which is meaningless during capture
anyway, so **nothing on screen moves when the microphone opens.** Its hit area is 44 × 44,
overhanging the visual slot.

Its meaning follows the phase: during capturing it discards the recording; during transcribing it
drops the in-flight request and the audio. Typed text already in the field survives either way.

**No slide-to-cancel, and no slide-to-lock.** Path-based gestures fail
[WCAG 2.5.1 Pointer Gestures (A)](https://www.w3.org/WAI/WCAG21/Understanding/pointer-gestures.html);
dragging fails [2.5.7 Dragging Movements (AA)](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).
iOS Messages is the model to copy (b): stop, then **Send / Listen to review / Add to the end /
Cancel** — all buttons, no gestures.

**No confirmation dialog.** Two independent sources agree: Apple HIG Feedback (a) — *"don't warn
people when data loss is the expected result of their action"* — and
[NN/g on confirmation dialogs](https://www.nngroup.com/articles/confirmation-dialog/) (a) — *"Do
not use confirmation dialogs for routine actions"*, because *"if you cry wolf too many times,
people will stop paying attention."* **(c) The consequential act here is send, not discard.**

## 2.8 Permission

**Ask on the first tap of the mic. Never at launch. No priming screen.**

[HIG Privacy](https://developer.apple.com/design/human-interface-guidelines/privacy) (a) — note
that `/accessing-private-data` now 301-redirects here, and that microphone is explicitly in scope
under *"Device capabilities like camera and microphone"*:

- *"Request permission only when your app clearly needs access to the data or resource."*
- *"Ideally, wait to request permission until people actually use an app feature that requires
  access."*
- *"Avoid requesting permission at launch unless the data or resource is required for your app to
  function."*
- On the purpose string: *"Aim for a brief, complete sentence that's straightforward, specific,
  and easy to understand."* / *"Use sentence case, avoid passive voice, and include a period at
  the end."*

Apple's own worked example table uses **microphone strings** — directly comparable:

| | Example | Apple's note |
| --- | --- | --- |
| ✅ | "The app records during the night to detect snoring sounds." | *"An active sentence that clearly describes how and why the app collects the data."* |
| ❌ | "Microphone access is needed for a better experience." | *"A passive sentence that provides a vague, undefined justification."* |
| ❌ | "Turn on microphone access." | *"An imperative sentence that doesn't provide any justification."* |

**On priming screens:** Apple permits them and names microphone as in scope, with strict rules —
*"Include only one button and make it clear that it opens the system alert"*, titled *"Continue"*
or *"Next"* (titling it "Allow" is called out as manipulation), and *"Don't include additional
actions in your custom screen or window."*

**We decline to ship one.** The mic glyph in the composer is already the statement of intent; a
screen in front of the sheet is a second ask for the same thing, and the purpose string is where
the explanation belongs. Recorded as a decision, not an oversight.

**Engineering rules that bind** —
[Protecting the user's privacy](https://developer.apple.com/documentation/uikit/protecting-the-user-s-privacy) (a):

- *"If your app supports audio input, configure your audio session for recording only at the point
  where you actually plan to begin recording."*
- *"The system alerts users when apps configure their audio session for recording"* — a silent
  trust cost that will not show up in QA.
- *"Provide reasonable fallback behavior in situations where the user doesn't grant access."*

And a trap: `AVAudioApplication.requestRecordPermission` (iOS 17+) documents that *"Unless a user
grants your app permission to record audio, it captures only silence (zeroed out audio samples)."*
**(c) Denial fails silently and is indistinguishable from "the tutor didn't hear me." The button
must be gated on permission state before capture, not after.**

**The denied state must not be a dead button.** iOS shows its alert once per install, so every
later tap has to lead somewhere. The design reuses **board 14's `state/error · auth` idiom
verbatim** — a message in 17/25 `--color-ink`, a recovery chip (301 × 62, `--radius-lg`,
elevation 03, `control/settings` glyph in `--color-icon`) reading **Open Settings**, and one line
of 15/18 secondary reassurance. It sits above the composer on the panel surface, not in a modal
alert over the board.

⚠️ [`openSettingsURLString`](https://developer.apple.com/documentation/uikit/uiapplication/opensettingsurlstring)
(a) only promises *"your app's custom settings"* — **it does not deep-link to the Microphone
toggle.** The copy must not promise more than it delivers.

**Two compliance notes for whoever owns them:**

- **Guideline 5.1.1(iv)**: *"Where possible, provide alternative solutions for users who don't
  grant consent."* Typing is that alternative, and the denied copy says so.
- **Guideline 5.1.4 (Kids)**: apps that *"collect, transmit, or have the capability to share
  personal information… from a minor must include a privacy policy and must comply with all
  applicable children's privacy statutes."* Sending a child's voice to OpenAI puts this app in
  scope.

## 2.9 Silence, noise, and empty results

**No silence timeout.** A student thinking mid-derivation is exactly the student this app is for,
and every published default would cut them off:

| System | Silence timeout | Source |
| --- | --- | --- |
| **Apple keyboard dictation** | **30 s** | (a) iPad User Guide, verbatim |
| OpenAI Realtime `server_vad` | **500 ms** default | (a) API reference |
| OpenAI Realtime `semantic_vad` | eagerness low **8 s** / medium 4 s / high 2 s | (a) same |
| Azure `SegmentationSilenceTimeoutMs` | 100–5000 ms range | (a) learn.microsoft.com |
| Google Cloud STT | no published default | (a) — genuine gap |

**(c) `server_vad`'s 500 ms is roughly 60× shorter than what Apple ships for the same job.**
Corroborating: NN/g's
[intelligent-assistant study](https://www.nngroup.com/articles/intelligent-assistant-usability/)
(a) found pauses were *"often interpreted by the assistant as the end of the query"*; Google's
[Dialogflow CX voice guidance](https://docs.cloud.google.com/dialogflow/cx/docs/concept/voice-agent-design)
(a) advises *"in situations where users need to review information or make decisions before moving
on, increase the no-speech-timeout setting."* And silence is precisely what drives Whisper
hallucination (§1.6), so a generous timeout and a hallucination guard are the same defence.

**One cap: 1:00.** Matching Apple's own — *"Plan for a one-minute limit on audio duration. This
limit is similar to the one for keyboard-related dictation."* **It transcribes what it has rather
than discarding**, so [WCAG 2.2.1 Timing Adjustable](https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable.html)
is not engaged — nothing is lost at the boundary. The elapsed timer in the text lane is the
warning.

**Empty result.** One line of 15/18 · 400 · `--color-ink-secondary` in the band above the pill:
**"I didn't catch anything that time."** No chip — the retry is the mic, 12 pt below, already
under the student's thumb. It clears on the next tap of anything, never on a timer.

Copy rule from [Google Conversation Design](https://developers.google.com/assistant/conversation-design/errors)
(a), which distinguishes *No Input* from *No Match* and warns: **"Don't say 'I didn't hear you',
because it's likely the user hasn't said anything."** Our line says the tutor missed it, not that
the student failed — and it does not claim to have heard silence.

**The guard must be more than `isEmpty`.** Documented Whisper-family failure modes on silence (b):
the empty string; a stray `" you"`; fluent YouTube-caption boilerplate — "Thank you.", "Please
subscribe", "Subtitles by…"; substantive fabrications (~1 %); and repetition loops. Treat a
short, high-frequency boilerplate result as empty rather than as a message, and rely on the
composer-review step for everything else.

## 2.10 Accessibility

Two of these are not preferences.

| Requirement | Why |
| --- | --- |
| **`.startsMediaSession` on the mic button** | (a) Apple's own example is literally this case: *"you might use this trait to silence VoiceOver speech while the user is recording audio."* Without it, VoiceOver speaks into the microphone this feature just opened. |
| **`accessibilityPerformMagicTap()` → start/stop** | (a) The iPad VoiceOver gesture list maps two-finger double tap to *"Start or stop the current action (for example… **start or stop a recording**)"*. That gesture already belongs to the user. Unwired, UIKit falls through to Music play/pause. |
| Constant label, changing value | (a) Apple's model: label = identity, value = state. Label stays **"Dictate"**; `accessibilityValue` carries "Recording" / "Transcribing". Flipping the *label* between "Record" and "Stop" is the anti-pattern. Trait `.toggleButton`. |
| One `.announcement` per phase change | [WCAG 4.1.3 Status Messages (AA)](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html). Per-frame announcements would be the "too chatty" failure the Understanding doc warns about. |
| Start and stop earcons | Amazon (a): the sound *"allows the customer to know your assistant has heard their request without looking at the screen."* The meter is unavailable to a student who cannot see it. |
| 44 × 44 hit areas | Apple's current Accessibility HIG gives iPadOS **default 44 × 44, minimum 28 × 28**, while the Buttons page still says *"a button needs a hit region of at least 44x44 pt."* **(c) Design to 44** — stricter, unconditional on Buttons, and a primary mic button is exactly the case for the larger number. It also clears [2.5.8 (AA, 24 pt)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) and 2.5.5 (AAA, 44 pt) for free. |
| No path gestures | 2.5.1 (A) and 2.5.7 (AA) — see §2.7. |
| Non-text contrast | `--color-icon` `#55565A` on `--color-surface` `#FFFFFF` is **7.3:1**, well clear of [1.4.11's 3:1](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html). The meter also carries its meaning in shape, not colour. |
| Voice Control | "Tap Dictate" must work. A discrete command, which a hold gesture could not receive. |

**Switch Control:** Apple's documented vocabulary is *"select, tap, or drag items, type, and even
freehand draw"*, and holding is absent from every list — but **(c) I could not find primary
confirmation either way.** Labelled as inference. (The Switch Control "Long Press" *setting*
refers to holding the physical switch, not an on-screen control — do not cite it.) A tap-toggle
sidesteps the question entirely, which is a further argument for §2.2.

**One non-colour note.** Apple's own recording indicator becomes an **orange square** when
Differentiate Without Color is on (a). Our meter is shape-only in a single grey, so it inherits
that property by construction.

## 2.11 Unavailable — the mic simply isn't drawn

No API key, no network route, no capture device: **there is no mic button.** Not a disabled one —
this system has no disabled controls anywhere, and there is nothing the student could do about it.
This settles `03-chat-components.md §7.4`'s open question in a way it did not anticipate: the mic
belongs in **both** composers, and its *absence* now carries meaning.

Distinguish it from denied. Denied keeps the mic because Settings can fix it. Unavailable has no
such route.

---

# Part 3 — The board

**`15 — Components · Dictation`**, 1680 × fit-content, in the documentation row. Construction
matches board 14 exactly: `--font-doc` titles, `--font-mono` spec values, 13 px eyebrows, 389 ×
`padding: 44` stages in `--color-surface-panel` at radius 20, a spec column with 37 pt rows on a
`--color-divider` hairline.

| Section | Contents |
| --- | --- |
| 01 — Capturing & transcribing | idle · capturing · transcribing · partial text arriving |
| 02 — When nothing comes back | empty result · error |
| 03 — Permission & availability | requesting permission · denied · unavailable |
| 04 — The same states at 740 | idle · capturing · transcribing · partial, at 828 stages |
| 05 — Reaching it another way | the accessibility contract |
| Settled | what was added, what it cost, what is left open |

## Values introduced

**One new component, `ui/level`.** It introduces **no colour, no fill, no radius and no
elevation** — five bars in `--color-icon` at `--radius-full`, which is what `state/thinking`'s dot
already is, stretched.

Its numbers are derived rather than invented:

| Value | Panel | Full screen | Derivation |
| --- | --- | --- | --- |
| Bar width | 6 | 8 | Panel: `state/thinking`'s dot, already documented as component-internal. Full screen: `--spacing-2`. |
| Gap | 8 | 12 | `--spacing-2` · `--spacing-3` |
| Min height | 6 | 8 | **= the bar width**, so silence renders a circle. |
| Max height | 25 | 30 | `--leading-body` · `--leading-lead` — the line box the lane already occupies. |
| Total width | 62 | 88 | Derived. |

**The only number with no derivation behind it is the bar count, five** — chosen because three
reads as the thinking dots and seven does not fit the panel's 133 pt lane. It is documented on the
board as a component-internal constant, in the same manner as `state/thinking`'s 6 pt dot and
`state/streaming`'s 2 × 22 caret.

**One non-visual value: a 44 × 44 hit area** for the cancel glyph at panel scale, larger than the
24 pt slot it sits in. That is a touch target, not a visual value — it draws nothing — and it comes
from Apple's stated default rather than from taste.

**`state/thinking` and `state/streaming` at 740** were previously undefined; board 15 specifies
them (dots 8 / gap 12; caret 2 × 26).

## Things this board does not touch

- **`DS.Color.correct` / `DS.Color.incorrect`.** Stroke-only, reserved for the tutor judging the
  student's work. A listening indicator is not a correctness signal and a failed upload is not a
  wrong answer.
- **The brand violet.** It appears exactly where it already did — `btn/send`. Nothing dictation
  adds is violet.
- **Borders.** None. `--color-divider` remains the tool rail's alone; on this board it appears
  only as documentation chrome under spec rows.
- **The mic's geometry.** 38/20 and 52/26, no fill, no radius, unchanged in every state.

---

# Appendix — sources

**OpenAI**
- [Speech to text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Audio API reference](https://developers.openai.com/api/reference/resources/audio)
- [Pricing](https://developers.openai.com/api/docs/pricing)
- [Error codes](https://developers.openai.com/api/docs/guides/error-codes)
- [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
- [Whisper model card](https://github.com/openai/whisper/blob/main/model-card.md)
- [ChatGPT voice dictation FAQ](https://help.openai.com/en/articles/12168547-voice-dictation-faq)

**Apple**
- [HIG · Privacy](https://developer.apple.com/design/human-interface-guidelines/privacy)
- [HIG · Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)
- [HIG · Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)
- [HIG · Playing audio](https://developer.apple.com/design/human-interface-guidelines/playing-audio)
- [HIG · Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [SFSpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer)
- [Protecting the user's privacy](https://developer.apple.com/documentation/uikit/protecting-the-user-s-privacy)
- [`NSMicrophoneUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription)
- [`openSettingsURLString`](https://developer.apple.com/documentation/uikit/uiapplication/opensettingsurlstring)
- [`.startsMediaSession`](https://developer.apple.com/documentation/uikit/uiaccessibilitytraits/startsmediasession)
- [VoiceOver gestures on iPad](https://support.apple.com/guide/ipad/use-voiceover-gestures-ipad9a246584/ipados)
- [Dictate text on iPad](https://support.apple.com/guide/ipad/dictate-text-ipad997d9642/ipados)
- [Audio messages](https://support.apple.com/guide/iphone/send-and-receive-audio-messages-iph2e42d3117/ios)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

**Standards**
- [WCAG 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html)
- [WCAG 2.5.1 Pointer Gestures](https://www.w3.org/WAI/WCAG21/Understanding/pointer-gestures.html)
- [WCAG 2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- [WCAG 2.2.1 Timing Adjustable](https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable.html)
- [WCAG 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html)
- [WCAG 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html)

**Research and practice**
- [Karat et al., CHI '99 — speech vs typing error awareness](https://dl.acm.org/doi/10.1145/302979.303160)
- [Koenecke et al., "Careless Whisper", ACM FAccT '24](https://dl.acm.org/doi/10.1145/3630106.3658996)
- [Kid-Whisper, arXiv:2309.07927](https://arxiv.org/abs/2309.07927)
- [MathSpeech, arXiv:2412.15655](https://arxiv.org/abs/2412.15655)
- [NN/g — Response times](https://www.nngroup.com/articles/response-times-3-important-limits/)
- [NN/g — Progress indicators](https://www.nngroup.com/articles/progress-indicators/)
- [NN/g — Visibility of system status](https://www.nngroup.com/articles/visibility-system-status/)
- [NN/g — Confirmation dialogs](https://www.nngroup.com/articles/confirmation-dialog/)
- [NN/g — Intelligent assistant usability](https://www.nngroup.com/articles/intelligent-assistant-usability/)
- [Amazon — Invoking Alexa (attention states)](https://developer.amazon.com/en-US/docs/alexa/alexa-auto/invoking-alexa.html)
- [Amazon — Voice interoperability baseline guidance](https://developer.amazon.com/en-US/alexa/voice-interoperability/design-guide/baseline-guidance)
- [Meta Horizon — Voice technology design](https://developers.meta.com/horizon/design/voice-technology/)
- [Google — Conversation design, errors](https://developers.google.com/assistant/conversation-design/errors)
- [Telegram — Video messages and Telescope](https://telegram.org/blog/video-messages-and-telescope)

**Claims with no primary source, recorded as such**
1. There is **no Apple HIG page** on microphone or voice-input UI — verified by enumerating the
   Inputs hub, not by a failed search.
2. **No published guideline explicitly argues for an amplitude-driven waveform.** Meta's *"gauge
   and calibrate the volume from their mic"* is the closest; the rest is inference.
3. **`openSettingsURLString` does not deep-link to the Microphone toggle.**
4. **Whether Switch Control can synthesise a sustained press is undocumented** either way.
5. **WhatsApp / Telegram maximum voice-message duration is undocumented.**
6. The HIG line *"don't display inaccurate progress information just to make your app appear
   busy"* is **legacy text, absent from the current page.** Do not cite it.
7. **WCAG 2.5.2 is not what rules out hold-to-talk** — 2.1.1 is. The 2.5.2 claim is widely
   repeated and wrong.
