# Contributing to Askaboard

Askaboard is a desktop app for learning with an AI agent on a shared board.
The agent you already use connects over MCP, sees the board, draws on it and
talks with you.

Contributions are welcome. This is a small project with one founder, so read
this page before you start.

## Run it

```sh
git clone https://github.com/Nordup/askaboard.git
cd askaboard/apps/desktop
npm install
npm run dev     # the dev app
npm run build   # type-check and bundle
```

[`apps/desktop/README.md`](apps/desktop/README.md) tells how to connect an
agent and how the app is built.

## No tests

The project has no tests. This is on purpose (see the hard rules in
[`AGENTS.md`](AGENTS.md)). Do not add test files or test dependencies.
Run `npm run build`. Then use your change in the real app, from start to end.

## Before a big change

Open an [issue](https://github.com/Nordup/askaboard/issues) or a
[discussion](https://github.com/Nordup/askaboard/discussions) first. A short
talk costs less than a pull request that we cannot merge.

## Pull requests

- Fix one problem in one pull request.
- Tell what you changed and how you checked it in the app.
- For a UI change, add a screenshot or a short video.
- The UI follows one design system: [`docs/design-system.md`](docs/design-system.md).
  Read it before a UI change.

## Agents and docs

- An AI agent that works in this repo reads [`AGENTS.md`](AGENTS.md) first.
- The reference docs (architecture, decisions, design and guides) are in
  `docs/`. Start at [`docs/README.md`](docs/README.md).
- Open work is in the [issues](https://github.com/Nordup/askaboard/issues).

## License

By contributing, you agree that your work is under the [MIT License](LICENSE).
