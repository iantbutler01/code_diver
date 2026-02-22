---
name: dive-tag
description: Add structured @dive comments and maintain .dive metadata so code changes are explainable and navigable.
user-invocable: false
---

# Dive Tag

## Goal

Maintain a lightweight, cumulative knowledge graph while coding by:

1. Adding `@dive` comments near meaningful logic
2. Maintaining project metadata in `.dive/overview.md` and `.dive/modules/*.md`

Use this skill automatically whenever you modify code.

## Required Outputs

### 1) File-level headers

At the top of any source file you create or substantially modify, add:

```text
@dive-file: <what this file is responsible for>
@dive-rel: <relationship to another file/module/dependency>
@dive-rel: <another relationship, if relevant>
```

Comment syntax must match the language:

- Rust/JS/TS/Go/Java/C/C++/C#: `//`
- Python/Shell/Ruby/YAML/TOML: `#`
- HTML/XML/Markdown: `<!-- -->`

Examples:

```rust
// @dive-file: Validates JWT tokens and creates auth context for requests.
// @dive-rel: Called by src/api/middleware.rs for every authenticated route.
// @dive-rel: Uses src/auth/session.rs to reject revoked sessions.
```

### 2) Inline tags

Add `@dive:` comments for non-trivial logic you write or change.

Format:

```text
@dive: <plain-English behavior and outcome>
```

Good:

- `@dive: Normalizes user input so lookup is case-insensitive`
- `@dive: Retries DB write once when the first attempt times out`

Avoid:

- Restating syntax
- Vague notes like "does stuff"
- Tagging every trivial line

### 3) System metadata

Create/update `.dive/overview.md` at the project root.

Required structure:

```markdown
# System Overview
<brief system description>

## Components
- **<Component>** - <responsibility> -> <path>

## Relationships
- <Component A> -> <Component B>: <how they interact>
```

### 4) Module metadata

Create/update `.dive/modules/<module>.md` for modules affected by your changes.

Required structure:

```markdown
# <Module> Module
<module purpose>

## Files
- `<relative/path>` - <file responsibility>

## Relationships
- <file A> -> <file B>: <dependency or call flow>
```

## Operating Rules

1. Keep paths project-relative (for example `src/auth/jwt.rs`).
2. Update metadata incrementally when behavior changes.
3. Preserve existing useful entries; refine instead of replacing wholesale.
4. Prefer directional relationships (`A -> B` or `A <- B`) with short context.
5. If `.dive/` does not exist, create it with `overview.md` and `modules/`.
6. If uncertain, write conservative descriptions and avoid guessing internals.

## Minimal Workflow

1. Read existing `.dive/overview.md` and relevant `.dive/modules/*.md` if present.
2. Implement code changes.
3. Add/update file headers and inline `@dive:` tags in touched files.
4. Update `.dive/overview.md` if component boundaries or interactions changed.
5. Update relevant `.dive/modules/*.md` for touched files and relationships.

## Completion Checklist

- Touched files include accurate `@dive-file` and `@dive-rel` headers
- New or changed logic includes meaningful `@dive:` comments
- `.dive/overview.md` exists and reflects current component structure
- `.dive/modules/*.md` exists for touched modules and links to real files
