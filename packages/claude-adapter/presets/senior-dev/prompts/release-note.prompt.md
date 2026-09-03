# Release note

For: a release or changelog entry.

```markdown
# <version or release name> — <date>

## Added
## Changed
## Fixed
## Deprecated / Removed
Each entry: one line, in user-visible terms, no file paths.
Omit any section with no entries.

## Upgrade notes
Anything an operator or consumer must do: migrations to run, configuration to
set, API versions retiring, order of deployment. `None.` when nothing is needed.

## Known issues
Only what is real and unresolved.
```

Do not list internal refactors that no user or operator can observe.
