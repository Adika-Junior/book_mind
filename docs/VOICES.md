# Voices for read-aloud: Piper, personal voices and professional voices

BookMind reads documents aloud with two engines:

1. **Natural voices (Piper).** These are neural voices that run on your own BookMind server (`bookmind/services/tts.py`).
2. **Device voices (Web Speech API).** These are whatever the browser offers. They are the fallback whenever a natural voice can't be reached.

This document covers:

- how the natural voices work
- which ones to install and under what licence
- how to create a **personal voice** (your own) or a **professional voice** (a hired voice actor)
- the consent and legal rules that apply to both

Status: researched and implemented September 2026. Sources are linked inline and listed at the end.

---

## 1. Why Piper

| | Device voices (Web Speech) | Piper on your server |
|---|---|---|
| Quality | Varies wildly by device; some are robotic, some are cloud voices | Consistent neural voices, same on every device |
| Privacy | Some browsers send the text to a cloud service | Text never leaves your server |
| Offline | Works offline only with on-device voices | Pages you've heard replay offline (the service worker caches each sentence's audio). Otherwise BookMind falls back to the device voice sentence by sentence |
| Cost | Free | Free; runs faster than real time on a CPU |
| Custom voice | Impossible | Any voice you train (sections 4–5) |

Piper ([OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl), GPL-3.0-or-later) is a VITS model exported to ONNX, with espeak-ng turning text into phonemes. On this project's test machine, the low-quality Lessac voice produced a 5-second sentence in about 0.2 s once loaded; loading the voice took about 1.5 s the first time.

**How BookMind uses it**

- **One sentence per request.** `GET /api/v1/tts?voice=…&text=…` returns WAV. It's a GET so the browser and service worker can cache it: the same voice and text always give the same audio.
- **No gaps between sentences.** The player fetches the next sentence while the current one plays.
- **Speed.** The speed slider changes the playback rate with pitch preserved, so one cached recording serves every speed.
- **Fallback.** If the server is unreachable and the sentence isn't cached, that sentence is read by the device voice. Reading never stops.
- **Resource limits.** The service loads at most two voices at a time and synthesises at most `BOOKMIND_TTS_CONCURRENCY` sentences at once. Audio is cached in memory (48 MB) and in each browser (up to 600 sentences, oldest evicted first).

## 2. Installing voices, and their licences

```bash
python tools/voices.py list                  # installed voices + the recommended catalog
python tools/voices.py get en_GB-cori-high   # download from rhasspy/piper-voices (Hugging Face)
python tools/voices.py get en-us-lessac-low  # legacy voices come from GitHub releases
# Docker Compose (fills the `voices` volume; the only step that needs internet):
docker compose -f deploy/docker-compose.yml --profile tools run --rm tts-voices get en_GB-cori-high
```

Voices are files in `BOOKMIND_VOICES_DIR` (default `data/voices/`):

- `<id>.onnx` and `<id>.onnx.json`: the model and its Piper config.
- `<id>.MODEL_CARD`: the upstream card.
- `<id>.card.json`: BookMind's record of the voice's source, licence note, SHA-256 and install date. The API and UI show the licence.

**A voice's licence is not Piper's licence.**

- The engine is GPL-3.0.
- The [piper-voices repository](https://huggingface.co/rhasspy/piper-voices) is MIT.
- But each voice is a model trained on somebody's recordings, and the recordings' licence carries through to the voice.

Always read the `MODEL_CARD` before deploying a voice commercially ([Piper voices licensing discussion](https://github.com/rhasspy/piper/discussions/271), [licensing overview](https://www.cekura.ai/discover/piper-tts)).

| Voice | What we found | Use it for |
|---|---|---|
| `en_US-lessac-*`, `en-us-lessac-low` | Trained on the Blizzard 2013 Lessac data, whose research licence **excludes commercial speech products**. Several other voices were *fine-tuned from Lessac*, which may carry that restriction with them ([piper1-gpl#314](https://github.com/OHF-Voice/piper1-gpl/issues/314); unanswered at the time of writing) | Personal use, research, evaluation. It's the voice BookMind's tests use |
| `en_GB-cori-high` | Trained on public-domain LibriVox recordings (~24 h) ([model](https://huggingface.co/Trelis/piper-en-gb-cori-high)) | A good default for a public deployment. Still confirm the MODEL_CARD |
| Voices trained on LibriTTS | LibriTTS is CC BY 4.0: commercial use allowed **with attribution**. Put the attribution in `card.json` → shown in the app | Commercial use with attribution |
| Others (`alba`, `ryan`, `northern_english_male`, `sw_CD-lanfrica`) | Check each MODEL_CARD | — |

For a deployment in Kenya:

- A Kenyan-English Piper voice doesn't exist yet. British English voices are the closest in pronunciation of legal English.
- A Swahili voice exists (`sw_CD-lanfrica-medium`, Congolese Swahili).
- A **Kenyan voice made for BookMind** (section 4 or 5) is the way to get one. It is also the only route to a voice whose licence you fully control.

## 3. Personal vs professional voices

| | **Personal voice**: you, a colleague, a volunteer | **Professional voice**: a hired voice actor |
|---|---|---|
| Who records | Someone close to the project | A voice actor in a studio |
| Audio quality | Laptop mic in a quiet room works; a USB mic in a treated room is better | Studio-grade and consistent, the biggest single factor in quality |
| Paperwork | A consent record (section 5) | A **written contract** plus the consent record: scope, payment, term, revocation, exclusivity (section 5) |
| Cost | Your time: ~1,300 sentences ≈ 3–5 hours of recording | Studio time and a licence fee; voice actors increasingly price "digital replica" rights separately |
| Result | Recognisably that person | A polished voice that suits long listening |

The technical process is the same for both (section 4). What differs is recording quality and the legal agreement.

## 4. How to create a custom Piper voice

The method is **fine-tuning**: start from an existing Piper checkpoint and train it on the new speaker's recordings. Training from scratch needs ~13,000 sentences and 20+ hours. Fine-tuning needs roughly a tenth of that, because the checkpoint already knows how to speak ([CodingKiwi's walkthrough](https://blog.coding.kiwi/training-a-custom-piper-tts-voice/), [ssamjh's guide](https://ssamjh.nz/create-custom-piper-tts-voice/)).

**Step 1: write the script.** Aim for ~1,300–1,500 sentences with broad phonetic coverage:

- Start from the [piper-recording-studio](https://github.com/rhasspy/piper-recording-studio) prompt set.
- Add domain sentences, because the voice learns what it hears. For BookMind that means:
  - clause numbers and cross-references ("section 26(3)(b)")
  - defined terms ("deployer", "high-risk artificial intelligence system")
  - Kenyan place and institution names
  - figures ("one million shillings")

  `tools/ingest.py` output (`data/chunks.json`) is a ready source of real sentences.
- Vary length and sentence type: statements, questions, lists.

**Step 2: record.**

- **Room:** quiet and non-echoey. Soft furnishings help; a wardrobe full of clothes is a classic home booth. Avoid other voices and background noise.
- **Microphone:**
  - Use the same mic, the same distance (a fist's width, slightly off-axis) and the same level for every session.
  - A pop filter helps.
  - A laptop mic *can* work, but consistency matters more than price ([training tips](https://playbooks.com/skills/sammcj/agentic-coding/piper-tts-training)).
- **Delivery:** the calm, even reading voice you want BookMind to have. Don't perform. Re-record any sentence with a stumble; listen back before moving on.
- **Format:**
  - mono WAV, 16-bit, **22,050 Hz** (Piper's "medium"/"high" rate; 16 kHz for "low")
  - one file per sentence, silence trimmed to about 0.1–0.2 s at each end
- **Tool:** piper-recording-studio runs in a browser, shows each prompt, and writes the audio plus `metadata.csv` for you.
- **Effort:** plan 3–5 sessions of about an hour. Voices tire, and tired audio trains a tired voice.

**Step 3: prepare the dataset.** Piper's trainer reads a pipe-separated CSV and a folder of audio ([TRAINING.md](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/TRAINING.md)):

```
utt0001.wav|Clause 34 sets out the offences and penalties under this Act.
utt0002.wav|A deployer of a high-risk artificial intelligence system shall keep records.
```

**Step 4: fine-tune from a checkpoint.** Use a GPU with 8 GB or more of VRAM. The reference voices were trained on an RTX 3090 or an A6000; users report success on 8 GB cards. A cloud GPU rented by the hour is fine.

```bash
pip install "piper-tts[train]"           # the piper1-gpl training extra
python3 -m piper.train fit \
  --data.voice_name "en_KE-amina-medium" \
  --data.csv_path dataset/metadata.csv \
  --data.audio_dir dataset/wav/ \
  --model.sample_rate 22050 \
  --data.espeak_voice "en" \
  --data.cache_dir cache/ \
  --data.config_path en_KE-amina-medium.onnx.json \
  --data.batch_size 32 \
  --ckpt_path checkpoints/en_GB-cori-high.ckpt
```

- **Choosing a checkpoint.** Pick one from [rhasspy/piper-checkpoints](https://huggingface.co/datasets/rhasspy/piper-checkpoints) in the same language and quality, and with **an acceptable licence**. Fine-tuning from Lessac can carry the Blizzard research-only restriction into your voice (section 2); prefer a public-domain or CC-BY base such as Cori.
- **How long to train.** Roughly 1,000 extra epochs; about a day on a single consumer GPU. Listen to samples as you go; stop when it stops improving.
- **Accent.** The espeak voice sets the pronunciation dictionary. `en` (British-based) generally suits Kenyan English better than `en-us`.

**Step 5: export and install.**

```bash
python3 -m piper.train.export_onnx --checkpoint lightning_logs/version_0/checkpoints/last.ckpt \
  --output-file en_KE-amina-medium.onnx
python tools/voices.py add --onnx en_KE-amina-medium.onnx --config en_KE-amina-medium.onnx.json \
  --id en_KE-amina-medium --name "Amina" --license "Private — this BookMind deployment only" \
  --consent consent/amina.json
```

The voice appears under **Natural voices (Piper)** in the reader's voice menu within 30 seconds; no restart is needed.

**Step 6: evaluate before you publish.**

- Have 3–5 listeners rate naturalness (1–5) on 20 unseen sentences from the documents, compared with the stock voice.
- Check it on the hard cases: clause numbers, acronyms (AI, ICT, KES), Swahili names.
- Fix bad pronunciations by adding those words to the script and fine-tuning briefly again.

**Shortcut: a synthetic dataset.** People have produced a Piper voice from just a few phrases. They first clone the voice with a large zero-shot model, have it read the whole script, then train Piper on that synthetic audio ([Cal Bryant](https://calbryant.uk/blog/training-a-new-ai-voice-for-piper-tts-with-only-4-words/), [Hackaday](https://hackaday.com/2025/07/09/how-to-train-a-new-voice-for-piper-with-only-a-single-phrase/)). It is faster, but:

- quality is capped by the cloning model
- that model's own licence applies
- it makes cloning *anyone* from a short clip trivial

That last point is exactly why section 5 is non-negotiable.

## 5. Consent, contracts and the law

A voice model *is* the person's voice. Treat it like their signature.

**Kenya:**

- **The AI Bill in this very corpus makes misuse an offence.** Clause 34(1)(i) covers generating, deploying or distributing synthetic media "using a person's image, voice or likeness without their explicit consent" where it causes or is likely to cause harm, misinformation, defamation or infringement of privacy (Bill, p.11).
- The Bill defines "synthetic media" in clause 2 (p.2).
- It empowers regulations on "procedures for obtaining consent, labelling artificial intelligence generated content, and reporting non-consensual synthetic media" (Bill, p.12).
- **The Data Protection Act, 2019 treats voice as biometric, and therefore sensitive, personal data.**
  - Processing it needs consent for a specified purpose.
  - The controller must be able to *prove* that consent.
  - Transfer out of Kenya needs informed consent ([Act](http://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/2019/TheDataProtectionAct__No24of2019.pdf), [ODPC guidance on biometric data](https://www.odpc.go.ke/wp-content/uploads/2025/11/ODPC-%E2%80%93-Guidance-Note-on-Biometric-Data.pdf)).
  - Training on a cloud GPU abroad is such a transfer; say so in the consent.

**Industry practice for professionals:**

- SAG-AFTRA's 2025 contracts require **separate, written, clear and conspicuous, reasonably specific consent** before a digital replica is made or used, and the performer is paid for it ([Davis+Gilbert on the Commercials Contract](https://www.dglaw.com/importance-of-digital-replica-consents-under-the-sag-aftra-commercials-contract/), [SAG-AFTRA on AI](https://www.sagaftra.org/contracts-industry-resources/member-resources/artificial-intelligence)).
- The union's position is that "opt-out is not consent" ([SAG-AFTRA](https://www.sagaftra.org/sag-aftra-members-approve-2025-video-game-agreement)).
- Voice-replica agreements such as SAG-AFTRA's with Replica Studios let performers **opt out of continued use in new works** ([SAG-AFTRA](https://www.sagaftra.org/sag-aftra-and-replica-studios-introduce-groundbreaking-ai-voice-agreement-ces)).
- Even non-union and outside the US, these terms are the benchmark.

**What BookMind enforces:**

- `tools/voices.py add` refuses to install a custom voice without a consent record containing:
  - `speaker`
  - `granted_to`
  - `scope`
  - `date`
  - `signature`
  - `revocation_contact`
- The TTS service **refuses to serve**:
  - any voice marked `"custom": true` that has no consent record
  - any voice whose card says `"consent": false`

  So revoking consent means setting `"consent": false`, and the voice disappears within 30 seconds (`tests/test_tts.py`).

A consent record (`consent/amina.json`) looks like this. Keep the signed original, plus a recording of the speaker reading the consent statement, as proof:

```json
{
  "speaker": "Amina W.",
  "granted_to": "BookMind deployment operated by <organisation>",
  "scope": "Reading aloud the documents published in BookMind, for its users. Not advertising, not other products, not new recordings of statements the speaker didn't read.",
  "date": "2026-09-01",
  "term": "Until revoked; reviewed yearly",
  "compensation": "KES … flat fee + … per year of use",
  "training_location": "GPU rented in <country> — speaker informed (DPA 2019 s.49)",
  "signature": "sha256 of the signed PDF: …",
  "recorded_statement": "consent/amina-statement.wav",
  "revocation_contact": "voices@<organisation>"
}
```

**A professional contract should also settle:**

- **Scope:** which products, which content, which languages.
- **Term and territory.**
- **Exclusivity.**
- **Payment:** a session fee *and* a usage fee.
- **Approvals:** the actor may hear and veto the voice before launch.
- **Labelling:** the app says the voice is synthetic (BookMind's voice menu says "Natural voices (Piper)").
- **Security:** the model file is access-controlled like a credential.
- **Deletion on termination:** what happens to the dataset, the checkpoints and the `.onnx`.

**Don'ts:**

- Don't clone a public figure.
- Don't clone a voice from podcast or YouTube audio.
- Don't clone "for a demo" without consent. The Bill's offence doesn't care about intent, only harm.

## 6. The cloud alternative (and why BookMind doesn't need it)

Commercial services build custom voices with less effort. Both bake consent into the process:

- **Microsoft Azure Custom Neural Voice (Professional).**
  - It is a Limited Access feature: you apply, and only certain use cases are approved.
  - The voice talent must record a **verbal consent statement** that Microsoft checks against the training audio ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-neural-voice), [Limited Access](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/limited-access?view=foundry-classic)).
- **ElevenLabs Professional Voice Cloning.**
  - Needs at least 30 minutes of audio (2–3 hours is best).
  - Includes a **voice CAPTCHA**: you read a prompt, and it must match the training voice ([ElevenLabs docs](https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/professional-voice-cloning)).

Both are high quality, but they send every sentence to a third-party cloud (a data transfer under the DPA) and charge per character. They also don't work offline. Piper keeps the voice, the text and the listening on your own server, which is why BookMind uses it. Borrow their consent practice, though: a recorded consent statement matched to the voice is the best evidence you can hold.

## 7. Checklist

- [ ] Every installed voice has a `card.json`, and you've read its MODEL_CARD licence.
- [ ] No Lessac-derived voices in a commercial deployment (or written permission).
- [ ] Custom voice: signed consent, recorded consent statement, a contract for professionals.
- [ ] Training abroad was disclosed in the consent.
- [ ] The voice is labelled as synthetic in the app.
- [ ] You know how to revoke it: `"consent": false` in its card.

## Sources

- Piper engine and training: [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) · [TRAINING.md](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/TRAINING.md) · [piper-recording-studio](https://github.com/rhasspy/piper-recording-studio) · [piper-checkpoints](https://huggingface.co/datasets/rhasspy/piper-checkpoints)
- Guides: [CodingKiwi](https://blog.coding.kiwi/training-a-custom-piper-tts-voice/) · [ssamjh](https://ssamjh.nz/create-custom-piper-tts-voice/) · [Cal Bryant](https://calbryant.uk/blog/training-a-new-ai-voice-for-piper-tts-with-only-4-words/) · [Hackaday](https://hackaday.com/2025/07/09/how-to-train-a-new-voice-for-piper-with-only-a-single-phrase/) · [training tips](https://playbooks.com/skills/sammcj/agentic-coding/piper-tts-training) · [Australian voice from LibriVox](https://github.com/DataCraftsmanAustralia/piper-en_AU)
- Voice licences: [piper-voices](https://huggingface.co/rhasspy/piper-voices) · [licensing discussion #271](https://github.com/rhasspy/piper/discussions/271) · [piper1-gpl#314](https://github.com/OHF-Voice/piper1-gpl/issues/314) · [Cori model](https://huggingface.co/Trelis/piper-en-gb-cori-high) · [Piper licensing overview](https://www.cekura.ai/discover/piper-tts)
- Consent and law: [Kenya Data Protection Act 2019](http://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/2019/TheDataProtectionAct__No24of2019.pdf) · [ODPC biometric guidance](https://www.odpc.go.ke/wp-content/uploads/2025/11/ODPC-%E2%80%93-Guidance-Note-on-Biometric-Data.pdf) · [SAG-AFTRA AI resources](https://www.sagaftra.org/contracts-industry-resources/member-resources/artificial-intelligence) · [Davis+Gilbert on digital replica consent](https://www.dglaw.com/importance-of-digital-replica-consents-under-the-sag-aftra-commercials-contract/) · [SAG-AFTRA × Replica Studios](https://www.sagaftra.org/sag-aftra-and-replica-studios-introduce-groundbreaking-ai-voice-agreement-ces) · [2025 Interactive Media Agreement](https://www.sagaftra.org/sag-aftra-members-approve-2025-video-game-agreement)
- Cloud services: [Azure Custom Neural Voice](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-neural-voice) · [Azure Limited Access](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/limited-access?view=foundry-classic) · [ElevenLabs PVC](https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/professional-voice-cloning)
- The Bill: *The Artificial Intelligence Bill, 2026*, clauses 2, 34(1)(i) and the regulations clause. Read them in BookMind: Bill pp. 2, 11, 12.
