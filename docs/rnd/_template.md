# <experiment name>

_Status: proposed | active | shipped | revised | deferred | stopped_
_Started: <date> · Decided: <date>_

## Hypothesis

What user or maintainer problem this tests, and what I expect to happen.

## Fixture

Vault shape — notes, links, attachments — and the expected outcomes. Path to the
committed fixture or the bench command used.

## Metric

The one number that decides this: latency, recall, precision, token load, failed-call
rate, confirmation rate, or quality score. State the bar up front.

| | before | after |
|---|---|---|
| <metric> | | |

## Safety review

Data accessed, writes performed, logs emitted, rollback path.

## Kill criterion

The result that ends this experiment without shipping.

## Decision

Ship / revise / defer / stop — and the reasoning. Link the PR if it shipped.
