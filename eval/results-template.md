# Demo results — fill after actual runs

Date / operator / commit: **Unrun**

AWS Region and model IDs: **Unrun**

Bootstrap state path, dev backend key, lock and KMS verification: **Unrun**
Dev apply and subsequent no-change plan: **Unrun**

| Check | Status (pass/fail/unrun) | Sanitized evidence or failure |
| --- | --- | --- |
| Voltframe SVID and cited answer | Unrun | |
| Driftwood SVID and cross-tenant question | Unrun | |
| No match abstains without generation | Unrun | |
| Missing/untrusted caller identity | Unrun | |
| Trusted but unauthorized workload | Unrun | |
| Client-supplied tenant ID rejected | Unrun | |
| Incorrect Docker selector receives no SVID | Unrun | |
| SPIRE renewal and TLS reload | Unrun | |
| Scoped runtime role AssumeRole and model calls | Unrun | |
| Two retrieval configurations and frozen cases | Unrun | Current two-passage corpus does not support meaningful Recall@5. |
| Controlled failure, rollback, restoration timing | Unrun | |

Record the document IDs supplied to generation and the citations returned, without committing raw passage text or credentials. Mark each unexecuted check **Unrun**.
