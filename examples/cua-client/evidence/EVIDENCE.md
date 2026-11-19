# Family dark reference — preserved

Source: `openlock/.scratch/landing-mobile-addons.png` (the supplied family dark construction).
Preserved copy: `openlock/examples/cua-client/evidence/landing-mobile-addons.png`.
SHA-256: `51290008c0b02fafcb15f808e88d1c924c7bcccc7f84922b54023f4c4bd55d1c`.
Dimensions: 390 × 844 (mobile landing capture).

The client (`src/styles.css`) cites these roles from that image and the landing page it captures:

| Role | Token | Use in the CUA window |
|---|---|---|
| near-black ground | `#0c0e11` | window background |
| panel | `#12151a` | brand row, rail, composer, status |
| raised panel | `#171b21` | cards, launcher, drawers |
| hairline | `#262c34` | row and pane boundaries |
| strong hairline | `#363e49` | window edge, active boundaries |
| ink | `#eceff2` | primary text |
| muted | `#aab3bd` | body and secondary readings |
| dim | `#8a94a0` | labels and metadata |
| faint | `#7c8692` | hints and empty states |
| gold | `#f0c454` | tool-call accent, sea­led stars |
| green | `#8bd694` | verified / trusted |
| rose | `#e4786f` | refused / lapsed |

Purple (`#b9a4ff` text, `#7c3aed` solid) is the CUA brand accent only: the mark, the selected rail
row, selection borders and focus. It is not a state colour; every state also has a word.

The image is evidence of construction, not a render witness. The render stays `not-implemented`
until the owner looks at the built client.
