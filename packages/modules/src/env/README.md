# Env files

Every `.env`, `.env.<name>` and `<name>.env` of the project in one place, with secret-looking values masked until revealed. Edit keys in a table or the raw text without disturbing comments, blank lines or quoting; compare a file with its `.env.example` and add what is missing; switch `.env` between profiles (`.env.staging`, `.env.production`); a warning when a file with real values is committed or not gitignored; a history of every change Quiver made. Import a file into a Quiver environment (secrets encrypted) or export one back.

## How it works

Nothing is stored for this module: the files themselves are the data. Quiver scans the project up to four folders deep (skipping `node_modules`, `.git`, build output and the like) for `.env`, `.env.<name>` and `<name>.env`, classifies them (`.env` is the main file; `.env.example`, `.sample`, `.template`, `.dist` are examples; `.env.local` and `.env.<name>.local` are local overrides; any other `.env.<name>` is a profile) and watches those folders, so a change from your editor or a `cp` shows up at once. Parsing follows the `dotenv` package: `export` prefixes, `KEY: value`, unquoted values cut at `#`, `\n` escapes inside double quotes, literal single quotes and backticks, quoted values spanning lines, and the last of duplicated keys winning (earlier ones are shown as shadowed). Edits go through the parsed document and rewrite only the line they touch, keeping comments, blank lines, indentation, `export` and the quote style; new keys are appended. Before any write Quiver keeps the previous content (the last 20 versions per file, in `.quiver/local`) and the History tab restores any of them, including a deleted file.

Keys that look like credentials (`SECRET`, `PASSWORD`, `TOKEN`, `API_KEY`, `PRIVATE`, `DSN`, ... or a URL with `user:pass@`) are masked in the table and in the raw text until revealed. With git available, the sidebar warns when such a file is tracked (its values are in the repository) or not covered by `.gitignore`. Compare shows the keys an example defines that the file lacks (and the reverse, and the empty ones), with one click to append them with the example's placeholder values. Switching a profile copies `.env.<name>` over `.env`; the profile whose content `.env` currently has is marked active. "To environment" copies the keys into a Quiver environment for `{{variables}}`, storing secret-looking ones encrypted; `env.file.export` writes an environment back into a file, updating keys in place.

## Agents

`env_file_list`, `env_file_read` (secret values masked), `env_file_diff`, `env_profile_list`, `env_backup_list` and `env_file_import` are allowed. `env_file_read` with `reveal: true` needs the same switch as mutating commands, and so does every write: `env_file_set`, `env_file_write`, `env_file_unset`, `env_file_create`, `env_file_delete`, `env_file_sync`, `env_profile_use`, `env_backup_restore`, `env_file_export`.

## Verified by

The smoke builds a temporary project with a committed `.env`, an example, a profile, a nested app and a `node_modules` decoy, and checks discovery, parsing, masking for agents, in-place edits, compare and sync, profile switches, backups and restores, import to and export from environments, the UI table and the watcher, and in the text view that secrets stay masked until revealed and that a whole-file edit is saved, plus the backup history.
