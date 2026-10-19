| Host | Baseline build | Shared host build | Restore | Download | Saved per host | Runtime file differences |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| darwin/arm64 | 117.6s | 86.1s | 2.6s | 7.0s | 22.0s | 0 |
| linux/arm64 | 86.3s | 46.7s | 2.5s | 1.0s | 36.1s | 0 |
| linux/x64 | 89.6s | 59.5s | 3.1s | 4.0s | 23.0s | 0 |
| win32/x64 | 86.6s | 51.8s | 3.3s | 2.0s | 29.5s | 0 |

Shared producer job: 92.0s including setup, compilation, archiving and upload.
Net runner time saved across four hosts after charging the producer job: 18.5s.
Build measurements exclude consumer checkout/install and signing. Downloads and restoration are charged to shared builds. Runtime parity normalizes text line endings, asset references and manifest key order, excludes source maps, and permits native color rounding up to 0.00000101 in Display P3 or 0.00010001 in Lab. Other content must match. Artifact restoration always verifies exact producer hashes. The producer starts alongside release gates; any unfinished producer work still delays packaging.
