# Family Shopping List

A shared family shopping list. You can speak or type items, see which of Tesco, Asda, Sainsbury's and Aldi is cheapest, and tick items off in the order you find them in the shop.

## Hosting (Cloudflare Pages)
1. Create a Pages project called `family-shopping-list` from this repo. There is no build step and the output folder is `/`.
2. Create a KV namespace (e.g. `family-shopping-list`). In the Pages project, go to **Settings → Bindings** and add a KV binding named **`SHOP`**.
3. Redeploy. If `/api/ping` returns `{"ok":true,"storage":true}`, it's working.

Without the backend (for example opened as a plain file), the app runs in **preview mode** and saves to the phone only.

## How it works
- Each family has a code and password. Families can't see each other's lists.
- Each family's whole state is one KV record. Saves use version checks, so two people adding at the same moment won't overwrite each other.
- `functions/api/[[path]].js` handles register, login, getting and saving state, and logout.
- `sw.js` + `manifest.webmanifest` + `icon-*.png` make it installable; a 5-step tour runs on first use (Settings → Show the tour).

## Roadmap
- Live price checker (a scheduled Worker) for each shop, with a freshness badge.
- Barcode scan to add or teach an item.
- Price-drop alerts for regular items.
