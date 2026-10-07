# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

The five above are the triage roles. Delivery adds three states this tracker actually uses, which no triage role covers:

| State | Meaning |
| --- | --- |
| `claimed` | An agent or person has taken it and is working on it |
| `done` | Implemented, reviewed and committed on this branch |
| `resolved` | Implemented and accepted; superseded by `done`, kept so older tickets keep their original wording |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from the first table.

Edit the right-hand column to match whatever vocabulary you actually use.
