# Contributing

Issues and pull requests are welcome.

- **Bugs:** open an issue with what you did, what you expected and what happened. Say whether it runs on Workers or
  Node, and which GitHub (github.com or Enterprise Server).
- **An agent we do not recognise:** open a pull request that adds it to `KNOWN_AGENTS` in `src/agents.js`, with a test
  in `test/agents.test.js` showing a real commit's author, committer or trailer. Match names whole and addresses
  exactly, so people who share a name with an agent stay people.
- **Translations:** copy `public/locales/en.js`, translate the values (keep the `{placeholders}`), and add the
  language to `LOCALES` in `public/js/i18n.js`.
- **Changes:** for anything beyond a small fix, open an issue first so we can agree on the approach.
- **Pull requests:** keep them focused, add or update tests, and make sure `npm test` passes. The page has no build
  step and no framework; please keep it that way. Every value from GitHub goes into the page as text.
- **Security issues:** never in a public issue; see [SECURITY.md](SECURITY.md).

```sh
npm test         # the tests (Node 22.13+)
npm run demo     # the app with made-up data on http://localhost:8787
```

By contributing you agree that your contribution is licensed under the Apache License 2.0.
