# Documentation

Every page below answers one question. Pick the question you have.

New here? Read [get-started.md](./get-started.md) first — it runs the offline demo,
then walks the same pipeline against a page of your own.

## Get started

| Document                            | Answers                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| [get-started.md](./get-started.md)  | How do I get my first live verdict on a page I own?            |

## How-to

| Document                                                | Answers                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| [how-to/authentication.md](./how-to/authentication.md)  | How do I give the judge a signed-in session for my app?                  |
| [how-to/ci.md](./how-to/ci.md)                          | How do I run this unattended, and what does each exit code mean?         |
| [how-to/add-an-adapter.md](./how-to/add-an-adapter.md)  | How do I point the pipeline at an agent backend that is not bundled?     |
| [troubleshooting.md](./troubleshooting.md)              | This command printed an error — what do I do about it?                   |

## Explanation

| Document                                                                          | Answers                                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [explanation/pipeline.md](./explanation/pipeline.md)                              | What does each stage do, and why is the work split this way?         |
| [explanation/how-verdicts-are-decided.md](./explanation/how-verdicts-are-decided.md) | Why did this run come out `manual_review` instead of `pass`?      |

## Reference

| Document                                                        | Answers                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| [reference/cli.md](./reference/cli.md)                          | What are the thirteen commands and every flag they take?              |
| [reference/configuration.md](./reference/configuration.md)      | What config keys and environment variables exist, and which wins?   |
| [reference/annotations.md](./reference/annotations.md)          | Which `@qa-*` annotations does `spec` read, and what does each mean?|
| [reference/adapters.md](./reference/adapters.md)                | What can each adapter do, and what is the adapter contract?         |
| [reference/artifacts.md](./reference/artifacts.md)              | What files does a run write, and what is in the judgment JSON?      |
| [glossary.md](./glossary.md)                                    | What does this term mean in this project?                           |

## Elsewhere in the repo

- [../README.md](../README.md) — what the tool is, and whether it fits your problem
- [../examples/](../examples/) — annotated spec examples and the offline demo app
