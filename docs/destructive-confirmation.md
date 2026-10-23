# Destructive confirmation policy

Permanent `delete_note`, `move_note` with reference rewriting, and non-dry-run `rename_tag` require an explicit caller-supplied safety latch:

| Operation                     | Required latch                                        |
| ----------------------------- | ----------------------------------------------------- |
| Permanent deletion            | `confirm: true`                                       |
| Move with reference rewriting | `confirmPath` matches the normalized destination path |
| Tag rename                    | `confirmTag` matches the new tag                      |

These latches apply to every client. A matching interactive response cannot replace a missing latch.

## Clients with form elicitation

After validating the latch, the server asks the client to re-type the relevant path or tag. A matching accepted response permits the operation. Decline, cancellation, and an empty response leave the vault unchanged. A mismatched response aborts with an error.

If a form request is attempted, SDK timeout, invalid response schema, client error, or transport failure aborts the operation. MCP returns an `isError` result with a fixed confirmation-failure message. Logs record the tool and failure category without including the client's error message or confirmation response.

The form request inherits the tool's cancellation signal and uses the SDK's existing request timeout. Cancellation while confirmation is pending prevents a late acceptance from authorizing a mutation. It does not roll back a mutation that already began after a valid confirmation.

## Noninteractive fallback

The operator policy for clients without form elicitation is to rely on the explicit caller-supplied latch above. The server does not attempt a form request for those clients. This includes clients that advertise only URL elicitation. The SDK continues to interpret the legacy empty elicitation capability as form support.

Use clients with form elicitation when an interactive check is required. This fallback is available only when form support is absent; a failed attempted form request never falls back to the latch alone.

## Verification

`npm test -- src/__tests__/handlers/confirmation-failures.test.ts src/__tests__/handlers/delete-note-confirmation.test.ts src/__tests__/handlers/write.test.ts src/__tests__/handlers/tags.test.ts` covers shared-helper failures for all three operations, actual SDK timeout with a virtual clock, tool cancellation followed by late acceptance, schema errors, unsupported capabilities, matching and mismatched input, and independent latches. Protocol tests compare the vault contents before and after failed requests.
