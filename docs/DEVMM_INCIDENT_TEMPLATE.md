# DevMM Incident Template

Copy this section for each incident.

---

## Incident Metadata

- Incident ID:
- Date (UTC):
- Reporter:
- Environment (prod/staging/local):
- Service version or commit:
- Exchange:
- Pair:
- Strategy ID:
- Related failure code (`F01..F07`):

## Symptom

- User-visible behavior:
- Status snapshot:
- First observed timestamp:
- Blast radius (which exchanges/users):

## Evidence

- `status` output:
- key log lines (`orderAttempt`, `orderResult`, `decision`, `skipReason`):
- scheduler lines (`dispatch/skip`):
- raw exchange payload sample (if parser issue):

## Root Cause

- Immediate cause:
- Why guardrails did not stop it:
- Why it was not caught earlier:

## Fix

- Files changed:
- Behavior change:
- Backward compatibility impact:

## Verification

- Scenario(s) replayed:
- Commands run:
- Expected vs actual:

## Follow-Ups

- New/updated `Fxx` classification needed:
- Additional tests/checks needed:
- Documentation updates needed:
- Owner and due date:

