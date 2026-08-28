# 🪷 Tobyworld Lore Land Deed Viewer

**Unofficial community tool by ToadAid.** A local, read-only multi-wallet viewer for **Tobyworld Canonical Lore Land Deeds** on Base.

It discovers the Canonical Lore Land Deeds held by any number of wallet addresses, verifies ownership directly from Base, displays canonical traits, and locally caches NFT artwork for fast repeat viewing.

> **Read-only security model:** the viewer never asks for wallet connection, signatures, approvals, private keys, seed phrases, or transactions.

## Canonical collection

- Network: **Base Mainnet** (`chainId 8453`)
- Contract: `0x0495601af6f86efb14c9d478ea46b2aa09cb164a`
- Ownership authority: live Base `balanceOf()` + ERC-721 `Transfer` history + final `ownerOf()` verification
- OpenSea / SeaDN: metadata and artwork delivery only; never ownership authority

## What it does

- Tracks one or many wallet addresses; each wallet may own any number of deeds.
- Reads wallet balances at one pinned Base block.
- Builds a local contract-wide token → owner index from ERC-721 `Transfer` logs.
- Re-verifies every selected token with `ownerOf()` and fails closed if counts do not match.
- Caches the ownership index in browser local storage so later scans only need new blocks.
- Loads deed metadata and traits such as Background, Core, Keeper, Land, and Relic.
- Uses a loopback-only Python helper for OpenSea/SeaDN artwork resolution and local image-byte caching.
- Provides Wallet View, Gallery View, search, address masking, and JSON snapshot export.

## Requirements

- A modern browser.
- **Python 3.10+**. The helper uses only the Python standard library; no `pip install` is required.
- Internet access to Base RPC and metadata/artwork services.
- An OpenSea API key is optional but recommended for the most reliable artwork resolution.

## Windows

### Easiest method

1. Install Python 3 from <https://www.python.org/downloads/windows/>.
2. During installation, enable **Add python.exe to PATH**.
3. Download or clone this repository.
4. Double-click `start-vault.bat`.
5. The viewer opens at <http://127.0.0.1:7777/>.

PowerShell users can instead run:

```powershell
.\start-vault.ps1
```

If PowerShell blocks local scripts, the `.bat` launcher is the simplest option.

## Linux / macOS

```bash
chmod +x start-vault.sh
./start-vault.sh
```

Then open <http://127.0.0.1:7777/>.

## Optional OpenSea API key

The viewer works without a key by trying OpenSea's public item page / SeaDN path, but an API key makes artwork discovery more reliable.

### Recommended: save it once in a local `.env`

`serve-vault.py` automatically loads a `.env` file from the repository folder. Copy the included example, add your key once, and then use the normal launcher every time. Process environment variables take precedence over `.env` values.

**Windows Command Prompt**

```bat
copy .env.example .env
notepad .env
```

**Windows PowerShell**

```powershell
Copy-Item .env.example .env
notepad .env
```

**Linux / macOS**

```bash
cp .env.example .env
${EDITOR:-nano} .env
```

Set:

```text
OPENSEA_API_KEY=your-key-here
```

Then launch normally with `start-vault.bat`, `start-vault.ps1`, or `./start-vault.sh`. The `.env` file is already excluded by `.gitignore`.

### Normal OpenSea developer key

1. Sign in at OpenSea.
2. Open **Settings → Developer**.
3. Verify your email if requested.
4. Click **Get access** and submit the requested organization/website/use information.
5. Return to the Developer page and click **Create key**.
6. Keep the key private.

OpenSea documentation: <https://docs.opensea.io/reference/api-keys>

### Instant free-tier key

OpenSea also documents an instant key endpoint:

```bash
curl -X POST https://api.opensea.io/api/v2/auth/keys
```

Free instant keys are rate-limited and expire. If key creation returns HTTP `429`, wait for the creation-rate window to reset rather than repeatedly retrying.

### Or use a session environment variable

If you do not want a `.env` file, you can still set the key only for the current shell session.

**Linux / macOS**

```bash
export OPENSEA_API_KEY='your-key-here'
./start-vault.sh
```

**Windows Command Prompt**

```bat
set OPENSEA_API_KEY=your-key-here
start-vault.bat
```

**Windows PowerShell**

```powershell
$env:OPENSEA_API_KEY='your-key-here'
.\start-vault.ps1
```

**Never paste a real API key into `index.html`, commit `.env`, commit a modified launcher containing the key, or include the key in a shared screenshot.**

## First scan vs later scans

The Canonical Lore Land contract is not enumerable, so the first scan builds a contract-wide ownership cache by replaying `Transfer` events. That first run can take several minutes on the public Base RPC.

After that, the browser remembers the indexed block and current token-owner map. Future refreshes scan only newer blocks and then re-verify current ownership on-chain, making later wallet checks much faster.

The cache is an accelerator only. A result is considered complete only when live wallet `balanceOf()` totals exactly match independently verified `ownerOf()` results.

## Local data and privacy

The viewer stores wallet entries and its ownership cache in your browser's local storage. Artwork bytes are cached under:

```text
.lore-vault-cache/
```

This directory is ignored by Git.

If you enter multiple addresses, the viewer treats them as one local portfolio. **Do not publish exported snapshots or wallet lists unless you are comfortable revealing that those addresses may be related.**

## Artwork architecture

```text
Base blockchain
    ↓
read-only ownership proof
    ↓
canonical NFT metadata / traits
    ↓
localhost artwork helper
    ↓
OpenSea API (when key is present)
    ↓ fallback
OpenSea public item page / SeaDN
    ↓
local image-byte cache
```

OpenSea and SeaDN are display-media sources only. They do not determine what the wallet owns.

## Running manually

If you do not want to use a launcher:

```bash
python3 serve-vault.py
```

On Windows this may instead be:

```bat
py -3 serve-vault.py
```

Then open <http://127.0.0.1:7777/>.

## Troubleshooting

**`Address already in use`** — another program is already using port 7777. Stop the old viewer/server or set another port before launch.

**Artwork unavailable** — ownership can still be correct. Artwork is a separate delivery path. Add an OpenSea API key or retry after the upstream media service is available.

**Base RPC rate limiting** — the public Base RPC can throttle large historical scans. The viewer paces requests and caches the first successful contract scan; do not clear the ownership cache unless you need a complete rebuild.

**Ownership mismatch** — the viewer intentionally refuses to present a partial result as complete. Do not treat a failed/incomplete scan as an ownership statement.

## Scope and disclaimer

This is an **unofficial ToadAid community utility** and is not a Tobyworld or OpenSea product. It does not provide custody, trading, activation, signing, approval, or transaction functionality.
