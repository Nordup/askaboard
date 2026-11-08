# Privacy

Your boards stay on your Mac. They are files in your folder, and only the
agent you connect sees them.

The app sends anonymous usage events: for example, that a board opened or a
scene played. The events never include board content, scene text, spoken
lines, file names or folder paths. Each event has a hashed id, never your
account. Our server sends your IP address to PostHog with the events, to find
your approximate location (country and city). Neither our server nor PostHog
stores your IP address. The full list of events is in
[`apps/desktop/README.md`](apps/desktop/README.md#usage-data). To turn usage
events off, set `ASKABOARD_TELEMETRY_ENABLED=false` in the app's environment.

The free voice sends the agent's lines to Gemini, which makes the audio. Our
server does not store the text or the audio. The request to Gemini has storage
turned off, and Google does not use it to train models. For the daily limit
of the free voice, the server keeps your IP address for 7 days. Then it
deletes the address.

Questions about privacy: [nordup.ondr@gmail.com](mailto:nordup.ondr@gmail.com).
