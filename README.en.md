# Manhwa Arasseo!

[中文](README.md)

A Chrome extension that screenshots the Korean comics you're reading, finds the speech bubbles and lays the translation over them. For Japanese manga, use [MangaWakatta!](https://github.com/wren-11/manga-wakatta).

It works with **Korean manhwa** and translates into English or Simplified Chinese. The name is Korean for "Manhwa, got it!" (만화 알았어).

It's made for online manhwa sites such as Lezhin, Bomtoon, Ridibooks and Naver Webtoon, including vertical-scroll webtoons. Because it reads the screen rather than the image files, it works even in official readers that won't let you save pages.

## Install

1. [Download the ZIP](https://github.com/wren-11/manhwa-arasseo/archive/refs/heads/main.zip), unzip it, and keep the `manhwa-arasseo-main` folder somewhere safe.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder.

To update, unzip the new version over the old folder and hit the reload button on the extension in `chrome://extensions`.

Chromium-based browsers such as Edge, Brave and Arc install the same way, but so far it has only been tested in Chrome.

## Get an API key

Pick one:

- **Qwen** (Alibaba Cloud): cheap, with a free quota in some regions.
- **Claude**: the best results, pay as you go.

### Qwen

1. Sign in to [Alibaba Cloud Model Studio](https://bailian.console.aliyun.com).
2. Switch the region at the top of the console to the one nearest you. Speed depends on distance: from outside China, the Beijing region takes 10–20 seconds a screen, while a nearby region (Singapore, if you're in Australia or Southeast Asia) is much faster.
3. Click "API-KEY" at the bottom left, create a key and copy it. Also copy the Base URL labelled "OpenAI 兼容地址" (OpenAI compatible).
4. Right-click the extension icon → **Options**, choose Qwen, paste the key and Base URL, and save.

New accounts on aliyun.com get a free quota in the Beijing region only. Other regions are pay per use. According to Alibaba, new accounts on [alibabacloud.com](https://www.alibabacloud.com) get a free quota in Singapore.
If you use a free quota, open `qwen3-vl-plus` under Models and switch on "免费额度用完即停" (stop when the free quota runs out) so you're never billed. It's off by default.

**Checking your free quota:** in the console, go to Models, search for `qwen3-vl-plus` and open it. The "免费额度" (free quota) section shows how many tokens are left and when they expire.

**After the free quota runs out:** top up your Alibaba Cloud account, then go back to the `qwen3-vl-plus` page and switch off "免费额度用完即停". Your key and the extension's settings stay the same. From then on you pay per use, and if your balance hits zero the account goes into arrears, so keep a little credit in it.

### Claude

1. Sign in to [platform.claude.com](https://platform.claude.com) and add credit under Billing. On Claude Max or Team, you can use your monthly API credit instead by linking it under Settings → Billing → API credits on claude.ai.
2. Create a key under API Keys and copy it.
3. Right-click the extension icon → **Options**, choose Claude, paste the key and save.

Your key stays in your browser. Don't share it.

## Use

Settings take effect as soon as you save, no reload needed. If your comic tab was open before you installed the extension, refresh it first.

Open a comic and click the extension icon, or press `Option + K` (`Alt + K` on Windows). The shortcut differs from MangaWakatta's, so you can install both.

- **Webtoons (translate as you read)**: after pressing the shortcut once, just scroll and pause. Whatever has newly come into view gets translated. Translations scroll with the page, stay put when you scroll back up, and aren't charged twice. Moving to another episode (including the site's own back button) or changing the window width starts over.
- **Translate the whole episode**: press `Option + Shift + K` (`Alt + Shift + K` on Windows) or click the button at the bottom right. The page races from the top of the episode to the bottom, then returns you to where you were so you can start reading. Translation carries on in the background, starting just ahead of where you're reading.
  - When started from the shortcut or the toolbar icon, it records the tab instead of taking screenshots, which is much faster. A "sharing" indicator briefly appears on the tab. Started from the button on the page, Chrome may not allow recording, so it falls back to screenshots (slower).
  - If the site is still loading (for example Lezhin's "loading" notice), it waits before capturing.
  - Scrolling or pressing a key during the scan stops it. Switching tabs pauses it, and it resumes when you come back.
- Missed a line? Stop on that screen and press `Option + K` again. It retranslates just that screen and keeps what's already there.
- Page-by-page readers: new pages are translated automatically. You can turn this off in Options. A page you've already translated isn't charged again.
- Change the shortcuts at `chrome://extensions/shortcuts`.

If you use a page translator such as Immersive Translate, set it to never translate your comic site, or it will translate the translations.

## Settings

- **Translate to**: Simplified Chinese / English
- **Translation boxes**: "Cover the original text only" leaves the art alone. "Grow" is easier to read but covers more art.
- **Maximum text size**: small / medium / large
- **Translate automatically after turning the page**: on by default

## Troubleshooting

- **Nothing happens**: it can't run on `chrome://` pages. If you just installed it, reload the comic page.
- **Shortcut does nothing**: check `chrome://extensions/shortcuts`. Another extension may already be using it.
- **Invalid key**: check it was copied in full. For Qwen, the key and Base URL must be from the same region.
- **Out of credit**: top up your account, or for Qwen, switch back to a region with free quota.
- **Boxes in the wrong spot**: the model sometimes puts a box in slightly the wrong place. Claude does better.

## Known issues

- Translations sit in white boxes over the original. The original isn't erased.
- Now and then a line gets skipped or a box lands in the wrong spot. Press the shortcut to retranslate the current screen.
- Tested on Lezhin so far. Other sites haven't been checked one by one yet.

## Plans and feedback

Planned: use on phones. Found a bug or want a feature? Open an [issue](https://github.com/wren-11/manhwa-arasseo/issues).

## Privacy

Screenshots go only to the AI service you pick. The extension has no server. When translating a whole episode, the tab recording is processed on your computer only and is never saved or uploaded. Only the captured frames are sent to your chosen AI service, just like screenshots.

## License

[MIT](LICENSE)
