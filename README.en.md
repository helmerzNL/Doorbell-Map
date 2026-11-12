# Doorbell Map – interactive neighbourhood map

🇳🇱 [Nederlandse versie van deze README](README.md)

> This is the English version of the README. The screenshots show the Dutch interface; the app itself can be switched to English (see [Languages and dark mode](#languages-and-dark-mode)).

An interactive map of the neighbourhood in which every house is **green**, **red** or **not marked** (for example for Halloween, St. Martin's Day or another door-to-door event: which houses do or do not want visitors to ring the bell). Visitors view the map in the browser or as an app on their phone; the admin draws the houses and manages everything in `/beheer` (the admin area), secured with a **passkey** or a **username and password** (optionally with two-step verification), and can invite others as admins. It runs as a single Docker container, for example on a NAS: you deploy it with [`docker-compose.yml`](docker-compose.yml) and your own `.env` (a copy of [`.env.example`](.env.example)); see [Deploy it yourself with Docker](#deploy-it-yourself-with-docker).

## Contents
- [Features in brief](#features-in-brief)
- [The website for visitors](#the-website-for-visitors)
- [Residents: My house](#residents-my-house)
- [Access via QR code](#access-via-qr-code-optional)
- [Languages and dark mode](#languages-and-dark-mode)
- [The admin area](#the-admin-area-beheer)
- [Settings](#settings)
- [Logging in: passkey, password and MFA](#logging-in-passkey-password-and-mfa)
- [Inviting more admins](#inviting-more-admins)
- [Audit log](#audit-log)
- [Editions: comparing earlier occasions](#editions-comparing-earlier-occasions)
- [Installing as an app and offline use](#installing-as-an-app-and-offline-use)
- [Deploy it yourself with Docker](#deploy-it-yourself-with-docker)
- [Releases and release notes](#releases-and-release-notes)

## Features in brief

**For visitors**
- Map based on OpenStreetMap (no API key) with coloured areas over the houses; click a house for its note.
- House numbers on the map (switch), a street filter with green/red counts, and an information window.
- **PDF** (A4 landscape) with map, legend, totals, logo, explanation and an overview of the marked houses, including date and time.
- **Installable as an app (PWA)** with its own app icon and **offline** use; as long as the app is not installed, there is an *Install* button in the menu bar (no prompt that opens by itself). See [Installing as an app](#installing-as-an-app-and-offline-use).
- The **overview with totals** (total and per status) is also shown on the front page when the admin switches it on; a button next to light/dark hides or shows the block.
- Works on phone (menu bar at the bottom, floating status bar) and desktop.
- **Multilingual** (Dutch and English, can be switched on in the admin area) and a **dark/light mode** with a button at the top right. See [Languages and dark mode](#languages-and-dark-mode).

**For residents**
- Residents change the status of **their own house** (one house per device); the admin approves it. See [Residents: My house](#residents-my-house).
- Quickly go to your house with a double-click or long-press.
- The **My location** button (below the zoom buttons) shows your own position as a blue dot, on by default (the browser asks for permission), so you only need one phone.
- Optional (switched on by the admin): the **Community** to share your position live and see the other participants as dots, with their own colour and symbol. See [My location and Community](#the-website-for-visitors).
- Optional: choose a house **only with the QR code** from the letter (one device per house), with a location check (geofence) and/or an access code for devices without GPS. See [Access via QR code](#access-via-qr-code-optional).

**For the admin**
- Draw and edit houses (colour, street, house number, note, corner points), set the map view (centre, zoom, min/max).
- Log in with a **passkey** or with a **username and password**, optionally with **two-step verification (MFA)** and recovery codes. See [Logging in](#logging-in-passkey-password-and-mfa).
- **Multiple admins**: the owner invites others with a link; everyone chooses their own passkey or password. See [Inviting more admins](#inviting-more-admins).
- **Approve or reject** changes by residents, with **push notifications**; **block** devices (also by IP); **schedule** changes until a date and time.
- **QR codes** per house: show, copy the link, renew, and a **printable PDF** with a card per house to deliver to the residents.
- **Editions**: the map of every occasion with a name and year, created as a copy of the live map or of another edition and edited separately; switch in the admin area between *Live* and editions and compare which houses took part then and now, with the numbers. The front page never changes because of them. See [Editions](#editions-comparing-earlier-occasions).
- Settings in seven clear tabs; the admin area can also be installed as its own **app**.
- Your own **logo** (with an optional small logo for the header), an optional **favicon** (also the icon of the installed app; the lantern by default), explanation, info box, **site and app name** and your own names for the statuses.
- Automatic **backups** after every save attempt (ZIP, with app settings, logos and devices), with short titles and manual backups.
- An **audit log** in the data folder with every change and who made it: an administrator or a resident's device, and per house what changed. See [Audit log](#audit-log).
- Version number and commit visible in the settings menu.

## The website for visitors

Example with random houses (map data © OpenStreetMap contributors).

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/publiek.png"><img src="docs/screenshots/publiek.png" width="270" alt="Public map"></a><br><sub>Public map</sub></td><td align="center" valign="top"><a href="docs/screenshots/straten-popup.png"><img src="docs/screenshots/straten-popup.png" width="270" alt="Show/hide streets per street"></a><br><sub>Show/hide streets per street</sub></td><td align="center" valign="top"><a href="docs/screenshots/uitleg.png"><img src="docs/screenshots/uitleg.png" width="270" alt="Explanation with info box"></a><br><sub>Explanation with info box</sub></td></tr>
</table>

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/mobiel.png"><img src="docs/screenshots/mobiel.png" width="220" alt="Mobile"></a><br><sub>Mobile</sub></td><td align="center" valign="top"><a href="docs/screenshots/straten-popup-mobiel.png"><img src="docs/screenshots/straten-popup-mobiel.png" width="220" alt="Streets (mobile)"></a><br><sub>Streets (mobile)</sub></td><td align="center" valign="top"><a href="docs/screenshots/info-vlak-mobiel.png"><img src="docs/screenshots/info-vlak-mobiel.png" width="220" alt="Info box in the explanation"></a><br><sub>Info box in the explanation</sub></td></tr>
</table>

**Public map** – with the association's logo; click a house for its note. At the top are the buttons for the explanation, the streets and the *More* menu (⋯) with the PDF buttons.

**Mobile** – at the top only the logo, the title, the switches for house numbers and edit and (on the right) the language choice and the dark/light button; the actions (info, streets, More) are at the bottom, with the status bar (green/red) always just above them.

**Streets** – with the street icon (🛣️) in the menu bar you switch the houses of each street on or off on the map (and in the PDF). Per street it shows how many houses are **green** and **red**, and at the top the total of the visible streets.

**Explanation and info box** – the association's text; it is shown automatically the first time and closes with the cross at the top right. At the top is the eye-catching green **info box** explaining that residents can change their own house; it disappears as soon as changing is switched off.

**Overview with totals** – at the top right of the map are the *total number of houses* and, per status, the number and the percentage, with a distribution bar. The admin switches the block on for visitors with *Also show on the front page* (*Settings → Config → Display*; off by default). When it is visible, a button next to the light/dark button lets a visitor hide or show the block; that choice is remembered on that device only.

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/voorpagina-totaal.png"><img src="docs/screenshots/voorpagina-totaal.png" width="400" alt="Overview with totals"></a><br><sub>Overview with totals</sub></td><td align="center" valign="top"><a href="docs/screenshots/voorpagina-totaal-verborgen.png"><img src="docs/screenshots/voorpagina-totaal-verborgen.png" width="400" alt="Hidden with the button at the top right"></a><br><sub>Hidden with the button at the top right</sub></td></tr>
</table>

**PDF export** – A4 landscape with legend, totals and the date and time (HH:MM) of the status. Page 2 contains the logo, the explanation and the overview of the marked houses. The PDF follows the chosen streets and the house numbers.

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/pdf.png"><img src="docs/screenshots/pdf.png" width="400" alt="PDF: map with legend and totals"></a><br><sub>PDF: map with legend and totals</sub></td><td align="center" valign="top"><a href="docs/screenshots/pdf-toelichting.png"><img src="docs/screenshots/pdf-toelichting.png" width="400" alt="PDF: logo, explanation and overview"></a><br><sub>PDF: logo, explanation and overview</sub></td></tr>
</table>

## Residents: My house
- In the **installed app** (PWA) the menu bar always has a **My house** button, plus a **Sync** button (🔄) with which you update the houses immediately (the app also refreshes itself every 30 seconds).
- In a **regular browser** there is an **Edit** switch (✏️) at the top. It is **on by default** (if you switch it off, the browser remembers that), so the *My house* button is in the menu bar; switch it off and that button disappears. *Save PDF* and *View PDF* are under the **More** menu (⋯), also in the app. On a small screen the bar with the status colours always floats just above the menu bar. In the app this switch is hidden.

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/bewerken-meer-mobiel.png"><img src="docs/screenshots/bewerken-meer-mobiel.png" width="190" alt="More menu"></a><br><sub>More menu</sub></td><td align="center" valign="top"><a href="docs/screenshots/bewoner-kies-huis.png"><img src="docs/screenshots/bewoner-kies-huis.png" width="190" alt="Choosing a house"></a><br><sub>Choosing a house</sub></td><td align="center" valign="top"><a href="docs/screenshots/bewoner-wacht.png"><img src="docs/screenshots/bewoner-wacht.png" width="190" alt="Waiting for approval"></a><br><sub>Waiting for approval</sub></td><td align="center" valign="top"><a href="docs/screenshots/bewoner-heropend.png"><img src="docs/screenshots/bewoner-heropend.png" width="190" alt="App reopened: the link stays"></a><br><sub>App reopened: the link stays</sub></td></tr>
</table>

**Quickly to your house** – with a mouse you double-click a house, on a touchscreen you long-press it (a little over half a second). *Edit* is then switched on (in the browser), the map jumps to the house and change mode starts; if you have not chosen a house yet, the app asks whether it is your house. A double-click outside the houses simply zooms in. In the admin area the same gesture selects the house in select mode.

**My location** – below the zoom buttons is the *My location* button (the crosshair). Your location is **on by default**: when the map opens, the browser asks for permission to use your location (after the explanation has been closed). On a first visit the explanation comes first, followed by the location question. If you allow it, the button switches on (blue), your position appears as a blue dot with a light circle for the accuracy, the map zooms to you and follows you as you walk. Without permission the map stays as it was and no message follows. If you move the map yourself, following stops (the dot stays) and a tap on the button takes you back; one more tap on the next state turns the location off. If you turn the location off yourself, it no longer starts by itself on that device (only that choice is remembered, in the browser); a tap on the button turns it back on. While the location is on the screen stays awake, and so it does while you share your position with the Community, so you do not have to keep unlocking your phone while walking (if your browser supports it; otherwise the screen simply dims). If the browser withdraws it, for example in battery saver mode, or you briefly switch to another app, the screen is kept awake again when you return and as soon as possible. If location is blocked, a tap on *My location* or on the Community button opens a short window explaining how to allow it again on iOS (Safari) and Android (Chrome). Your position stays on your phone: it is never stored or sent anywhere, unless you choose to share it with the Community (see below). Showing your location only works over **https**. The administrator can hide the button, and with it the location (see *Config*).

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/mijn-locatie-mobiel.png"><img src="docs/screenshots/mijn-locatie-mobiel.png" width="220" alt="My location: blue dot with accuracy circle"></a><br><sub>My location: blue dot with accuracy circle</sub></td></tr>
</table>

**Community** – optional, **off** by default; the administrator switches it on under *Settings → Config → Display → Community*. A second button (the three people) then appears below *My location* to share your position live. Sharing is always voluntary: you must confirm it first and one tap stops it. Anyone taking part sees the other participants as **dots** (with the count on the button); anyone who does not share sees nobody. No name is attached. In the confirmation window a participant also picks a **colour and a symbol** (for example an animal) that others see; without a choice it is the default purple dot. The administrator can switch this choice off with *Choose colour and symbol* (on by default), after which every dot is purple. The **title and text** of the confirmation window are set by the administrator under *Config → Texts* (per language; empty = default text). The server only keeps positions briefly in memory (not on disk) and deletes them as soon as someone stops, closes the page, or after 45 seconds without a signal; when the administrator switches the feature off every position is gone immediately. In the admin area the administrator sees all participants as dots on the map, with the count in the side bar. This only works if the *My location* button is on as well.

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/community-venster-mobiel.png"><img src="docs/screenshots/community-venster-mobiel.png" width="220" alt="Confirm sharing, with colour and symbol"></a><br><sub>Confirm sharing, with colour and symbol</sub></td><td align="center" valign="top"><a href="docs/screenshots/community-kaart-mobiel.png"><img src="docs/screenshots/community-kaart-mobiel.png" width="220" alt="Participants as dots, the number on the button"></a><br><sub>Participants as dots, the number on the button</sub></td><td align="center" valign="top"><a href="docs/screenshots/beheer-community.png"><img src="docs/screenshots/beheer-community.png" width="220" alt="Admin area: all participants on the map"></a><br><sub>Admin area: all participants on the map</sub></td></tr>
</table>

**In the admin area** this works too: double-click (or long-press) a house and select mode switches on with that house selected, even if you were just drawing (as long as no area is in progress).

### Access via QR code (optional)
If you want residents to only be able to link **their own house**, switch on *Choose a house only via QR code* under *Settings → Residents → Access via QR code*. Every house then has its own QR code with a secret that is **not** on the map (the house ids are public, which is why the secret is separate).
- **Handing out:** choose *Print QR codes (PDF)* (all streets or one street): an A4 with a card per house to deliver to the residents. The QR is one whole: the site title at the top and street + house number at the bottom are built into the image, with the app icon in the middle of the code. For a selected house in the editor a **QR code** button shows the code, lets you **copy the link**, download it as a PNG or **renew** it.
- **Sharing via WhatsApp:** in the house popup there is *Share via WhatsApp* (and, on a phone, sharing the card) with a prepared text. You change that text under *Settings → Config → Texts → Text when sharing via WhatsApp* (per language; *Residents → Access via QR code* has a pointer with a *Go to Config* button). The message and the card are in the default language of the site; when *Multilingual* is on, the popup has a language picker (with flags) to show and share them in another language, and the printable PDF follows the default language; `{adres}` becomes the address of the house and `{link}` the personal link (if `{link}` is missing, the link is added after the text). Empty = default text.
- **Resident:** scans the code with the phone's camera, confirms "Is this your house?" and can then change the house. In the *My house* screen, without a link, only the instructions to scan are shown; the map and the address list then no longer work for choosing a house.
- **One device per house:** if a house is already linked, the server refuses a second device. Remove the link (*Settings → Residents → Devices*) to be able to scan again.
- **Already linked, or house taken:** if someone scans a QR with a device that is already linked to a house (or a house that is linked to another device), a window appears to send the admin a **short message** (max. 300 characters), for example for a new phone or a move. The admin gets a push notification.
- **Revoking:** *Renew* (per house or all houses) invalidates the old QR codes.
- **Combination:** a valid QR replaces the access code for devices without GPS; the location check and the admin's approval still apply. If you switch QR-only off, everything works as before (map/list).
- **Note:** a QR is only as safe as the letter: anyone who photographs it can use it (hence one device per house, renewing and your approval). On iPhone a scanned link opens in the browser, not in the installed app; if you use *Only in the installed app*, the resident has to open the app after scanning. The secrets are in `data/db.json`, not in the backups.

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/qr-instellingen.png"><img src="docs/screenshots/qr-instellingen.png" width="400" alt="Settings: Access via QR code"></a><br><sub>Settings: Access via QR code</sub></td><td align="center" valign="top"><a href="docs/screenshots/qr-dialoog.png"><img src="docs/screenshots/qr-dialoog.png" width="400" alt="QR code of one house"></a><br><sub>QR code of one house</sub></td></tr>
<tr><td align="center" valign="top"><a href="docs/screenshots/qr-pdf.png"><img src="docs/screenshots/qr-pdf.png" width="400" alt="Printable PDF with a card per house"></a><br><sub>Printable PDF with a card per house</sub></td><td align="center" valign="top"><table><tr><td align="center" valign="top"><a href="docs/screenshots/qr-bevestigen.png"><img src="docs/screenshots/qr-bevestigen.png" width="150" alt="After scanning: confirm"></a><br><sub>After scanning: confirm</sub></td><td align="center" valign="top"><a href="docs/screenshots/qr-zonder-scan.png"><img src="docs/screenshots/qr-zonder-scan.png" width="150" alt="Without QR (QR-only)"></a><br><sub>Without QR (QR-only)</sub></td></tr></table></td></tr>
</table>

**Scheduling changes** – under *Settings → Residents → Schedule* switch on *Switch off changing at a date and time* and pick the moment with the date/time picker. Until that moment residents can make changes (browser and app); after that it is off. The two switches below it are disabled and ignored during that time; if you switch the schedule off, they apply again.

**Still switching green ↔ red after the end date** – next to the schedule is the switch *After the end date still switch between green and red*. If it is on, residents who already have a house can, after the end date, still switch their own house from green to red or the other way round (not from or to *not marked*, and not choose a new house), still with your approval. The *My house* button then only shows those two colours; visitors without a house no longer see the button (or *Edit*). This switch takes precedence over the two switches below it and only works when the schedule is on.

**Closing the site** – under *Settings → Residents → Schedule → Close the site* switch on *Close the site at a date and time* and pick the moment, for example after the event is over. Until then the site is simply open. After that, visitors see a **thank-you screen** instead of the front page and the map with the houses can no longer be viewed: the server then no longer sends houses, map view or counts at all, so they cannot be fetched through the browser either. Residents can then no longer link or change a house and the community stops working. Anyone who had the page open gets the thank-you screen at the next refresh (within about 30 seconds). You still see the map in the admin and can keep editing everything; *View site* shows you what visitors see. If you move the date to later or switch it off, the site is open again right away (the chosen moment is kept). If you choose a moment that has already passed, the site closes immediately; the admin asks for confirmation first. The thank-you screen shows the name of the site, the logo (the normal logo if there is no small logo) and a text; you change that text under *Config → Texts → Text of the thank-you screen* (per language; a default text is already filled in, *Default text* puts it back). The language choice and the light/dark button stay available. Phones that have the site installed as an app and have been offline for a while may still show the last saved map until their next connection.

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/instellingen-planning.png"><img src="docs/screenshots/instellingen-planning.png" width="330" alt="Schedule: close the site at a date and time"></a><br><sub>Schedule: close the site</sub></td><td align="center" valign="top"><a href="docs/screenshots/bedankscherm.png"><img src="docs/screenshots/bedankscherm.png" width="400" alt="Thank-you screen instead of the map"></a><br><sub>Thank-you screen</sub></td><td align="center" valign="top"><a href="docs/screenshots/bedankscherm-mobiel.png"><img src="docs/screenshots/bedankscherm-mobiel.png" width="150" alt="Thank-you screen on a phone"></a><br><sub>Thank-you screen on a phone</sub></td></tr>
</table>

**Simple display** – under *Settings → Config → Display* switch on *Simple display*. On the website the *House numbers* and *Edit* switches and the *Streets* button then disappear; *Info*, *My house* and *Save PDF* are then directly in the menu bar (the *More* menu is dropped) and Edit is always on.

**Access code for devices without GPS (optional)** – under *Settings → Residents → Access* you set a code of 4 to 6 digits (or choose *Random*) and switch on the switch. Anyone who then presses *My house* on a laptop or desktop first gets a field to enter the code (which you share, for example, in the neighbourhood app on WhatsApp). The device remembers the code (cookie, 1 year); if you change the code, everyone has to enter it again. Phones and tablets with GPS do not have to enter anything. This is off by default. Wrong attempts are limited per IP address. It is a usage restriction, not hard security (the code is stored in readable form for the admin, and the device type comes from the browser).

**Geofence (optional)** – under *Settings → Residents → Access* you switch on *Only in the neighbourhood (location)* and choose a radius (50–5000 m, default 500). The centre is the centre of the map view (or else of the houses). The check applies **only to phones and tablets with GPS**; laptops and desktops (without GPS) are not restricted and can simply make changes. When opening change mode and with every change the browser asks for the location; if it is outside the radius, less accurate than 200 m, off or not allowed, changing is not possible and a clear message follows. Viewing the map is possible anywhere. Requires HTTPS. The location comes from the device itself and the server cannot verify it: it is a usage restriction, not hard security.

**Info box** – under *Settings → Config → Texts* there is a separate text field for the info box. It appears as a striking green block at the top of the explanation on the website and explains that residents can change their own house. It disappears automatically as soon as changing by residents is switched off (or the scheduled date has passed).

**Preventing abuse** – under *Settings → Approve* and *Residents → Devices* every pending change and every registered device has a **Block** button. The device loses its link and pending changes, and can no longer make changes or choose a house. You can also block the **IP address** (note: housemates or neighbours behind the same router often share an IP). Under *Blocked* you remove a block again.

**Only allow in the app** – under *Settings → Residents* switch on **Only in the installed app**. The *Edit* switch then disappears for browser visitors (also on an open page, after refreshing), and the server refuses changes that do not come from the app. The app identifies itself with a header (`X-App-Mode: standalone`). That is a usage restriction: anyone who imitates the requests can send the header along, but every change must still be approved by the admin.

- A resident taps their house (or chooses their address) and confirms. That device is then linked to **one house** (cookie, 1 year). A single tap on your own house does nothing special (a popup, as with any house); changing only starts with **double-clicking or long-pressing** (or *My house*). After that every tap on that house (or a choice in the window) switches the colour: not marked → green → red → not marked. Other houses cannot be changed.
- The change is **only visible to others after the admin approves it**. In the meantime the resident sees the house with a dotted border and the message *Waiting for approval*; after the decision a message follows (approved or not applied). The admin can always change the status of a house themselves; a pending proposal then follows the new status or lapses if it matches exactly.
- Only a random device token (as a hash), the IP address of the last request (for blocking) and the chosen house are stored, no names or other personal data.
- The link and the proposal are **kept after closing the app**: they are on the server, with a local copy of the token as a backup (in case the cookie is cleared) and of the last status (in case there is no connection). Your own house also stays visible outside change mode (⏳ while the change is waiting for approval, then 🏠).
- The app **refreshes itself** (every 30 seconds, and as soon as you return to the app or are back online). If the admin approves a change, it appears on the device by itself, including a message "Your change has been approved".

## Languages and dark mode
- **Default language** – under *Settings → Config → Language* you choose the default language with a drop-down menu (with flags): 🇳🇱 Nederlands or 🇬🇧 English. That language applies to the site, the app, the PDFs, the admin area and the push notifications to the admin, **even when multilingual is off**.
- **Multilingual** – with the *Multilingual* switch (off by default) a flag with a drop-down menu with the supported languages appears at the top right of the menu bar. A visitor's choice is remembered in their browser and applies to that visitor (the admin area follows the same choice). If the switch is off, everyone gets the default language.
- **Texts per language** – when *Multilingual* is on, the *Config* tab has a **language bar with flags** below the language block. The fields below it are per language: choose a flag and you edit the name of the site and the app, the short name, the names of the statuses, the info box, the explanation and the text when sharing via WhatsApp for that language; a small flag next to a field shows which language it applies to. What you type is kept when you switch language until you press *Save*. An empty field in another language falls back to the Dutch text (the default info box and the default WhatsApp text are translated automatically); Dutch remains the source. When *Multilingual* is off you edit the fields of the default language. The logo and the other settings apply to all languages. In the English display the Dutch name of the tradition is replaced by *Halloween* everywhere.
- **Dark/light** – next to the flag is a button (moon/sun) with which every visitor switches between the light and the dark display. By default the site follows the device's setting; the choice is remembered. In the dark display the **logo inverts automatically** (black becomes white) and the map is dimmed a little. The button is always visible, even when multilingual is off.
- **Adding translations** – the source of all texts is Dutch; a dictionary per language (`public/js/lang-en.js`, key = Dutch text, value = translation; `{name}` is a variable) translates the page in the browser and the push notifications on the server. The tests (`npm test`) check that every translation has the same variables.

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/instellingen-config-talen.png"><img src="docs/screenshots/instellingen-config-talen.png" width="400" alt="Config: language bar with flags"></a><br><sub>Config: language bar with flags</sub></td><td align="center" valign="top"><a href="docs/screenshots/publiek-engels-taalmenu.png"><img src="docs/screenshots/publiek-engels-taalmenu.png" width="400" alt="English site with language menu"></a><br><sub>English site with language menu</sub></td><td align="center" valign="top"><a href="docs/screenshots/mobiel-engels-donker.png"><img src="docs/screenshots/mobiel-engels-donker.png" width="150" alt="Mobile: English and dark"></a><br><sub>Mobile: English and dark</sub></td></tr>
</table>

## The admin area (`/beheer`)

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/onboarding.png"><img src="docs/screenshots/onboarding.png" width="400" alt="Onboarding with setup code"></a><br><sub>Onboarding with setup code</sub></td><td align="center" valign="top"><a href="docs/screenshots/beheer-login.png"><img src="docs/screenshots/beheer-login.png" width="400" alt="Logging in with passkey"></a><br><sub>Logging in with passkey</sub></td></tr>
<tr><td align="center" valign="top"><a href="docs/screenshots/beheer-tekenen.png"><img src="docs/screenshots/beheer-tekenen.png" width="400" alt="Drawing a house"></a><br><sub>Drawing a house</sub></td><td align="center" valign="top"><a href="docs/screenshots/beheer.png"><img src="docs/screenshots/beheer.png" width="400" alt="Editing a house"></a><br><sub>Editing a house</sub></td></tr>
</table>

**Onboarding** – the first time you use the setup code (`SETUP_TOKEN`) to choose a username and how you log in: with a **passkey** or with a **password** (then turn on two-step verification right away, or later). If a passkey cannot work here (no HTTPS or no real domain name), the wizard explains why and you choose the password.

**Logging in** – with a passkey (fingerprint, face, PIN or security key) or with a username and password, plus the code from your authenticator app if MFA is on. See [Logging in](#logging-in-passkey-password-and-mfa).

**View and edit** – the admin area opens in **view** mode: only the map, without a side bar. Double-click (or long-press on a touchscreen) a house for a **popup** with which you directly make the house **green, red or not marked** (it is saved immediately) and which contains the **QR card** for the residents: with logo, address, QR and explanation. Below it are the **direct link** with a copy button, a **Share via WhatsApp** button (opens WhatsApp with a ready-made message and the link), on phones also **Share card…** (the image via the share menu), a **PNG** to download and *Renew*. With **✏️ Edit** you open the edit screen (drawing houses, selecting, searching, map view); **✓ View** takes you back (with unsaved changes it asks first).

**Bottom bar** – on a phone and in the installed admin app there is a bar at the bottom with **Edit** and **Settings** (with a badge for waiting notifications); on a laptop those buttons are in the header.

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/beheer-huis-popup.png"><img src="docs/screenshots/beheer-huis-popup.png" width="420" alt="Popup on a laptop"></a><br><sub>Popup on a laptop</sub></td><td align="center" valign="top"><a href="docs/screenshots/beheer-weergave-mobiel.png"><img src="docs/screenshots/beheer-weergave-mobiel.png" width="170" alt="View with bottom bar"></a><br><sub>View with bottom bar</sub></td><td align="center" valign="top"><a href="docs/screenshots/beheer-huis-popup-mobiel.png"><img src="docs/screenshots/beheer-huis-popup-mobiel.png" width="170" alt="Popup on a phone"></a><br><sub>Popup on a phone</sub></td></tr>
</table>

**Drawing a house** – choose a colour and click the corner points of the house; finish with the yellow starting point, a double-click or Enter. New houses get *no status* by default and the active street.

**Editing a house** (in the edit screen) – select a house (click, double-click or long-press) to change the colour, street, house number and note, or drag the corner points. Shortcuts: **G** green, **R** red, **Delete** delete, **Ctrl+S** save. The list on the left has a filter per street; the rest is dimmed on the map.

## Settings
The cog (⚙) in the bar slides the settings menu into view. It is divided into seven tabs (*Approve*, *Residents*, *Config*, *Security*, *Users* (owner only), *Editions* and *Backups*, with icons from [Material Design Icons](https://pictogrammers.com/library/mdi/), Apache License 2.0); each tab consists of cards with clear switches and a short explanation (also on a phone).

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/instellingen-goedkeuren.png"><img src="docs/screenshots/instellingen-goedkeuren.png" width="270" alt="Approve"></a><br><sub>Approve</sub></td><td align="center" valign="top"><a href="docs/screenshots/instellingen-bewoners.png"><img src="docs/screenshots/instellingen-bewoners.png" width="270" alt="Residents"></a><br><sub>Residents</sub></td><td align="center" valign="top"><a href="docs/screenshots/instellingen-bewoners-apparaten.png"><img src="docs/screenshots/instellingen-bewoners-apparaten.png" width="270" alt="Residents: devices and notifications"></a><br><sub>Residents: devices and notifications</sub></td></tr>
<tr><td align="center" valign="top"><a href="docs/screenshots/instellingen-config.png"><img src="docs/screenshots/instellingen-config.png" width="270" alt="Config"></a><br><sub>Config</sub></td><td align="center" valign="top"><a href="docs/screenshots/instellingen-beveiliging.png"><img src="docs/screenshots/instellingen-beveiliging.png" width="270" alt="Security"></a><br><sub>Security</sub></td><td align="center" valign="top"><a href="docs/screenshots/instellingen-backups.png"><img src="docs/screenshots/instellingen-backups.png" width="270" alt="Backups"></a><br><sub>Backups</sub></td></tr>
<tr><td align="center" valign="top"><a href="docs/screenshots/instellingen-gebruikers.png"><img src="docs/screenshots/instellingen-gebruikers.png" width="270" alt="Users"></a><br><sub>Users</sub></td></tr>
</table>

<p align="center"><a href="docs/screenshots/instellingen-mobiel.png"><img src="docs/screenshots/instellingen-mobiel.png" width="220" alt="Settings on a phone"></a><br><sub>Settings on a phone</sub></p>

**Approve** – the changes that residents requested for their own house and the **messages from residents**. Red **badges** with the number are at the cog, at the tab and at every list, in the page title and – in the installed admin area – on the **app icon**; they are also updated by a push notification when the app is closed. Approve or reject changes (or everything at once) and click *Dealt with* on a message to remove it.

**Residents** – everything around changing by residents:
- *Changes by residents*: on/off, and optionally only in the installed app (the *Edit* switch then disappears in the browser and the server refuses changes without the app header `X-App-Mode: standalone`).
- *Schedule*: close changing automatically at a date and time (with a date picker), optionally still switching green ↔ red afterwards, and close the whole site at a date and time (thank-you screen instead of the map).
- *Access*: only in the neighbourhood (location/geofence) and an access code for devices without GPS.
- *Devices*: registered devices, **alphabetical** by street and house number (handy for searching with many houses), with removing the link or **blocking** (optionally with IP address), and the *Blocked* list.
- *Notifications on this device*: push notifications for new changes.

**Config** – language (multilingual and default language), logo, name of the site and the app, the simple display, the *My location* button for visitors (on or off; on by default), the *Community* (live participants; off by default), *Choose colour and symbol* for the community (on or off; on by default), the names of the statuses, the info box, the explanation, the text when sharing via WhatsApp the title and text of the community window and the text of the thank-you screen (the texts per language).

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/instellingen-config-afbeeldingen.png"><img src="docs/screenshots/instellingen-config-afbeeldingen.png" width="270" alt="Config: logo, small logo and favicon"></a><br><sub>Config: logo, small logo and favicon</sub></td><td align="center" valign="top"><a href="docs/screenshots/instellingen-config-locatie.png"><img src="docs/screenshots/instellingen-config-locatie.png" width="270" alt="Config: My location and Community"></a><br><sub>Config: My location and Community</sub></td><td align="center" valign="top"><a href="docs/screenshots/instellingen-config-communityteksten.png"><img src="docs/screenshots/instellingen-config-communityteksten.png" width="270" alt="Config: title and text of the community window"></a><br><sub>Config: title and text of the community window</sub></td></tr>
</table>

**Security** – your own login: username, passkeys, password and two-step verification (MFA) with recovery codes. See [Logging in](#logging-in-passkey-password-and-mfa).

**Users** (owner only) – who can open the admin area and how each of them logs in, create and revoke invitation links, a new login link for someone who is locked out, and removing users. See [Inviting more admins](#inviting-more-admins).

**Editions** – create an edition with a name and year (a copy of the live map or of another edition), the numbers per edition, view or edit an edition, change the name or year, and delete. See [Editions](#editions-comparing-earlier-occasions).

**Backups** – after every save attempt a backup of the layout, the texts, the app settings, the logos, the residents' devices (including blocked ones) and all editions is made automatically; each backup shows what it contains, and restoring brings all of that back. Give a backup a **short title** (✎, max. 40 characters, for example "Everything" or "Layout only") or make one yourself with *Make backup*. Restoring or downloading is always possible; deleting (one or several at once) must be confirmed with your passkey (without a passkey: with your password and, if on, an MFA code).

**Version** – at the bottom of the menu is the version and commit of the running build (see [Version number](#version-number)).

### Push notifications for the admin
- In *Settings → Residents → Notifications on this device* turn on notifications on your own phone or computer. The server creates the (VAPID) keys itself and stores them in `data/db.json`.
- For a new change you receive a push notification (several changes shortly after each other are combined). If you tap it, the admin area opens at *Approve* and you can approve or reject; only then is the change applied.
- Requires **HTTPS**. On an iPhone/iPad Web Push only works if you first add the admin area to the home screen (iOS 16.4 or newer) and open it from there. A *Test notification* button checks whether it works.
- Expired devices are cleaned up automatically.

## Names of the statuses
Under *Settings (⚙) → Config → Display* you can change the names **Green**, **Red** and **Not marked**, for example to *Agreed* and *Not visited yet*. The colours stay green and red. The names apply everywhere: legend, popups, street filter, the PDF, the admin area and the push notification. Leave empty = default name.

## Drawing new houses
A newly drawn house has **no status** by default (not marked; in the admin area you can choose another status for new houses if you like). The **Street for new houses** field shows the active or last used street: it follows the house you select, the street filter or what you enter yourself. New, still empty houses get that street filled in beforehand, so you only have to enter the house number.

## House numbers and streets
- In the admin area every house has a **street** and a **house number** (separate fields; the street field suggests existing streets). With *Filter by street* you show only the houses of one street in the list; the rest is dimmed on the map.
- The *House numbers on the map* switch shows the number in the middle of every house (white with a dark outline, so easy to read). Numbers that do not fit in the house disappear and return when zooming in further.
- In *Set map view* you decide whether the numbers are **on by default** for visitors; visitors can switch that themselves with the switch in the menu bar (the choice is remembered).
- On the site you can hide or show the houses per street with the street icon. The PDF follows those choices (house numbers and visible streets).
- Older data with one *house number/name* field is converted automatically: that field becomes the house number.

## How it works
- **Map**: OpenStreetMap (via Leaflet), no API key needed. Google Maps was deliberately not used: it requires a paid key and its terms do not allow drawing over it and exporting to PDF.
- **Setting up the admin area**: search for your street and zoom in far; set the centre, the start zoom and the minimum/maximum zoom via *Set map view* (or adopt the current view). Visitors open the map (also in the app) with exactly that view; with *Automatic* the site shows all houses. In the same dialog you decide whether the house numbers are on by default for visitors. Under *Map area in the PDF* a frame on the map shows which area the PDF displays (by default all houses automatically) and you can set your own: move the map to the area you want, choose *Use current map as PDF area* and save. *Automatic* restores the default.
- **Onboarding**: the very first time `/beheer` asks for the `SETUP_TOKEN`, a username and a passkey or password; that first user is the **owner**. After that you can add an extra passkey or turn on MFA via *Settings* (⚙) → *Security* (do that so you do not get locked out) and invite others via *Users*.

> The PDF fetches map tiles directly from OpenStreetMap; keep usage modest
> ([tile usage policy](https://operations.osmfoundation.org/policies/tiles/)).

## Logging in: passkey, password and MFA
<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/onboarding-wachtwoord.png"><img src="docs/screenshots/onboarding-wachtwoord.png" width="420" alt="Setup with username and password"></a><br><sub>Setup with username and password</sub></td><td align="center" valign="top"><a href="docs/screenshots/mfa-instellen.png"><img src="docs/screenshots/mfa-instellen.png" width="170" alt="Setting up MFA: QR code for the app"></a><br><sub>Setting up MFA: QR code for the app</sub></td><td align="center" valign="top"><a href="docs/screenshots/mfa-herstelcodes.png"><img src="docs/screenshots/mfa-herstelcodes.png" width="170" alt="Recovery codes, shown once"></a><br><sub>Recovery codes, shown once</sub></td><td align="center" valign="top"><a href="docs/screenshots/beheer-login-mfa.png"><img src="docs/screenshots/beheer-login-mfa.png" width="170" alt="Logging in: the MFA step"></a><br><sub>Logging in: the MFA step</sub></td></tr>
</table>

Every user of the admin area logs in in one of these ways, or both:
- **Passkey** (recommended): fingerprint, face, PIN or security key; no password needed. Only works over **HTTPS** with a real domain name (or on `localhost`). If you open the admin area through an IP address, a name without a domain (`nas`) or a name that only exists at home (`.local`, `.lan`), the wizard explains why a passkey cannot work there.
- **Username and password**: works everywhere. At least 10 characters, at least 4 different characters and without your username; it is only stored as a `scrypt` hash. The username is not case-sensitive.
- **Two-step verification (MFA)**, optional with a password: after the password the admin area asks for a 6-digit code from an authenticator app (TOTP, for example Microsoft Authenticator, Google Authenticator or 1Password); a code works once. When you turn it on you get **8 recovery codes** that you only see once (copy or download them); each recovery code works once instead of a code from the app. The MFA secret is stored encrypted in `db.json`; the key is `secret.key` in the same data folder, so always back up that folder as a whole.

You set this up and change it in *Settings* (⚙) → *Security*. Sensitive actions (password, MFA, deleting backups or editions) are confirmed again: with your passkey if you have one, otherwise with your current password and, if on, an MFA code. If you have both a passkey and a password, a session started with the password can manage the map but not change your login; for that you log in with the passkey. You can only remove your last passkey if you have a password, and the password only if you have a passkey. A new password or turning MFA on or off signs you out on your other devices.
Failed attempts (password, MFA code, setup code) are limited per IP address and globally.

## Inviting more admins
<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/instellingen-gebruikers.png"><img src="docs/screenshots/instellingen-gebruikers.png" width="420" alt="Users: invite, new login link, remove"></a><br><sub>Users: invite, new login link, remove</sub></td><td align="center" valign="top"><a href="docs/screenshots/uitnodiging.png"><img src="docs/screenshots/uitnodiging.png" width="170" alt="The invitation on the guest's phone"></a><br><sub>The invitation on the guest's phone</sub></td></tr>
</table>

The first user is the **owner**. The owner invites others via *Settings* (⚙) → *Users* → *Invite someone*, optionally with a suggested username. You get a link (`…/beheer#invite=…`) that is **shown once**, **works once** and expires after **7 days**; send it yourself (chat, email or in person). Whoever opens it chooses their own username and passkey or password (and optionally MFA), so the owner never knows anyone's password. Only the hash of the link is stored.
- Everyone manages the map, the residents, the texts, editions and backups; only the owner manages users (the server enforces this).
- **New login link** creates a link for someone who can no longer log in (lost phone, forgotten password). The old login keeps working until the new one is set up; then the old passkeys, password and MFA stop working and that user is signed out on every device.
- **Remove** deletes the user with all their passkeys and ends their sessions. The owner cannot be reset or removed.
- At most 50 users (open invitations count). Users, invitations and login details are not part of the backups in the admin area.

### Nobody can log in any more?
If the owner has no working passkey, password or recovery code left, reset all login details to a fresh installation. The map, editions, backups and settings stay; all users and invitations are removed. Stop the container first, otherwise the running server writes its data back:

```bash
docker compose stop doorbell-map
docker compose run --rm doorbell-map node server/reset-login.js
docker compose up -d
```

Then open `/beheer`: the setup wizard asks for the setup code (`SETUP_TOKEN`) again. Invite the others again afterwards.

## After an update: old pages or scripts
Scripts and styles are requested per build with `?v=<version>-<commit>` and the HTML is never cached; this way you never get an old `admin.js` with new HTML (which gives errors such as
*Cannot set properties of null*). If you still see such an error after an update, refresh hard (Ctrl+Shift+R) or clear the site data; a proxy/CDN (e.g. Cloudflare) may be caching too aggressively.

## Releases and release notes
For every successful build on `main` the GitHub Action sets a tag `vMAJOR.MINOR.PATCH` (see [Version number](#version-number)) and also publishes a **GitHub Release** with official release notes: [all releases](../../releases). The notes are compiled automatically from the merged pull requests since the previous release, divided into **✨ New features and improvements**, **🐞 Fixed problems** and **📚 Documentation**, each with a link to the PR, plus the `docker pull` command for that version.
- **Layout:** a PR from a `fix/…` branch (or with fix/repair/crash in the title) counts as a fixed problem, a `docs/…` branch as documentation, the rest as a new feature. A clear PR title and a short list under *Wijzigingen* (changes) in the description therefore go straight into the release notes.
- **Handwritten notes:** if you put a file `docs/releases/vX.Y.Z.md` in place, the release uses that instead of the automatic notes (this is how [v1.0.0](docs/releases/v1.0.0.md) was made).
- **Creating (again) afterwards:** Actions → *Release* → *Run workflow* and enter the tag (for example `v1.0.5`). You can try it locally with `node tools/release-notes.js vX.Y.Z` (with `GITHUB_TOKEN` and `GITHUB_REPOSITORY` set).

## Version number
At the bottom of the settings menu (⚙) are the version and the commit of the running build, for example **v1.0.3 (9f2c4e1)**.
With every successful build of the GitHub Action the patch number goes up by 1 (the first build is v1.0.0); the build gets a git tag `v1.0.N` and the image is
also published under that tag (`ghcr.io/helmerznl/doorbell-map:v1.0.3`). The `1.0` part comes from the `VERSION` file: change that for a new minor or major version, and the counter starts again at 0.
Locally (without a build) the app shows `dev` with the commit from git. The workflow needs write access to the repo to set the tag (it is in `docker.yml`).

## Backups
After **every save attempt** (houses/layout, texts and settings, map view, logos, editions, unlinking or (un)blocking a device) the server makes a backup in the `backups` folder of the data folder: `DATA_PATH/backups` (in the container `/data/backups`). Every backup is one ZIP file, `sint_maarten-backup-<id>.zip`, containing:
- `backup.json`: the layout (houses + map view), the texts (explanation, names, status names, info panel, share text, community panel, thank-you screen and the translations), the **app settings** (the switches and choices in the admin area), the **residents' devices** and the **blocked devices**, and **all editions**;
- `files/`: the **logos** (logo, small logo and favicon) as separate images, so you can also take one out of the ZIP without the app.

Not in the backup: users, login details and invitations, the access code for residents, the QR secrets, the push keys, the **IP addresses of residents**, and pending changes and messages from residents. A device is only stored with the hash of its key, as in the database: that gets nobody in anywhere, but a device that still has its key is linked (or blocked) again after restoring. Restoring keeps the IP address the app currently knows for a device or block; a device gets it again on its next use. Backups from v2.0.0 still contain IP addresses: the server wipes them from the backups in `DATA_PATH/backups` on the first start (a backup you downloaded earlier you have to delete yourself), and they are removed on upload.

Identical states are not stored twice (the last use of a device does not count) and the **newest 50** are kept; older ones are removed, on every new backup and when the server starts (`MAX_BACKUPS` to change the number). `backup.json` is compressed in the ZIP; every backup holds the logos again, so count on roughly 50 × (the logos + the size of the live map per edition) of disk space.
A downloaded backup (.zip, download button in the list) can be added again with **Upload backup** (25 MB at most); it appears as a new backup in the list. The server first checks the whole file: every logo must match its sha256 in `backup.json` and be a PNG, JPEG or WebP of at most 5 MB, and a refused file changes nothing. A `.json` backup from an older version still works; it has no settings, logos or devices and leaves those alone when restored. A backup from a newer version of the app is refused: update the app first.
Restoring is possible in *Settings → Backups* (the current state is first saved as a backup itself); afterwards exactly the editions, settings, logos and devices from that backup are there. The access code for residents stays the current one (without a code the switch is off afterwards). A backup from before editions existed leaves the editions alone. The list shows for each backup what it contains (houses, settings, logos, devices and which editions). Deleting asks for confirmation with your passkey or password.
**Updating from a version with .json backups:** on the first start the server converts the existing backups (`<id>.json`) to `sint_maarten-backup-<id>.zip`, with the same content, and removes all but the newest 50 (200 were kept before). To keep more, set `MAX_BACKUPS` in `.env` before updating. An older version of the app no longer sees the ZIP backups (they do stay in the folder).
Every backup can get a **short title** (max. 40 characters, ✎ button), for example "Everything" or "Layout only". With *Make backup* you make a backup manually with your own title, even if nothing has changed.

## Audit log
Every change is written straight to **`DATA_PATH/audit-log.jsonl`** (in the container `/data/audit-log.jsonl`). The file has one JSON object per line (*JSON Lines*), so a change is added immediately without rewriting the whole file. You can read it with a text editor, or with for example `jq` (`jq -c 'select(.category == "house")' audit-log.jsonl`).

**Viewing it in the admin** – under *Settings → Audit log* the log is shown as a list, newest first, with the summary and the time of each line. This shows which houses have been changed, when and by whom (an administrator or a resident's device). By default only the **houses** are listed; use the *Show* field to pick *Settings and administration* or *Everything*. The search field searches street, house number, administrator or device, and *Show older* fetches the next 50 lines (opening stays fast, even with a very large log; only a search without a match reads the whole file). The screen is read-only and available to every logged-in administrator; the log itself stays as it is. The summaries are recorded in Dutch and stay Dutch when you view the admin in English. For your own tooling: `GET /api/admin/audit?category=house&q=…&limit=50&before=…` returns the same lines as JSON (when logged in as an administrator).

Every line has:
- `at`: when;
- `category`: **`house`** for a house, or **`site`** for everything else;
  - `house` covers: status, address, shape or note in the layout or in an edition, residents' proposals and approving or rejecting them, linking, unlinking or (un)blocking a device, and renewing a QR code;
  - `site` covers: settings and texts, map view, logos, editions, backups, users and login details, and messages;
- `action`: what happened, for example `proposed`, `approved`, `changed` or `settings`;
- `actor`: who did it:
  - an administrator: `{ "type": "admin", "id", "name" }`;
  - a resident's device: `{ "type": "device", "id" }`, with a fixed, random id per device;
  - or `system`;
- `summary`: the same change in a short Dutch sentence;
- and where it applies: the house (`house`: id and address), `from`/`to`, `changes` (for settings: old and new value), `device` (the device an approval is about) and `edition`.

Because a device always has the same id, you can see for example that one device changed its house three times: three `proposed` lines with the same `actor.id`.

Never in the log: IP addresses, passwords, codes (including the residents' access code: only that it changed), keys and coordinates (only that the shape of a house changed). A failed attempt, or saving without a difference, adds no line.

The audit log is not part of the backups (restoring does not change history), and the app never shortens it. Each change adds a few hundred bytes. You can archive or empty it whenever you like: the app creates the file again on the next change.

## Editions: comparing earlier occasions
An **edition** is the map of one occasion (for example *Sint Maarten 2025*), with its own **name and year** and its own statuses. The **live map** is what the front page shows. Creating or editing an edition **never** changes the live map: the server writes editions only to their own files, through their own API addresses.

- **Creating** – in *Settings → Editions* enter a name and year and choose *Copy of*: the **live map** or **another edition**. The new edition starts with the same houses and statuses and is independent of its source afterwards. A backup cannot be a source, and a map without houses is not copied.
- **Switching** – as soon as there is an edition, the overview card at the top right of the map has a *Map* list: **Live** or an edition. For an edition, tap a house to see its status in that edition and on the live map, with buttons to change the status **in that edition** right away.
- **Editing** – *Edit* opens the map chosen under *Map*. For an edition the top of the side panel says *You are editing the edition …* and the button reads *Save edition*: everything (status, street, house number, shape, adding or removing houses) is saved in that edition only. You can also view or edit an edition from the list in *Settings → Editions*. QR codes and changes by residents always belong to the live map.
- **Comparing** – *Compare with* puts two maps side by side (an edition and live, or two editions). The houses are then coloured by taking part (green): **green in both**, **only in the older one** (orange) or **only in the newer one** (blue); the rest is shown dashed grey. The overview card shows the numbers of both maps with the difference (total, green, red, not marked) and how many houses fall into each group. Houses are matched on the house itself, and otherwise on street and house number.
- **Overview** – the list in *Settings → Editions* shows the number of houses per edition and how many are green (with percentage), red and not marked, what it is a copy of and when it was edited, with the live map at the top. The text field icon changes the name or year; deleting is confirmed with your passkey or password.
- *Hide counts* folds the overview card down to just the lists (handy on a phone).

Editions are stored as separate files in `data/editions/` (at most 100) and are part of **every backup**; restoring brings them back too (see [Backups](#backups)).

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/beheer-edities-vergelijken.png"><img src="docs/screenshots/beheer-edities-vergelijken.png" width="420" alt="Comparing an edition with the live map"></a><br><sub>Comparing an edition with the live map</sub></td><td align="center" valign="top"><a href="docs/screenshots/beheer-edities-bewerken.png"><img src="docs/screenshots/beheer-edities-bewerken.png" width="420" alt="Editing an edition"></a><br><sub>Editing an edition</sub></td></tr>
<tr><td align="center" valign="top"><a href="docs/screenshots/instellingen-edities.png"><img src="docs/screenshots/instellingen-edities.png" width="420" alt="Settings: Editions"></a><br><sub>Settings: Editions</sub></td><td align="center" valign="top"><a href="docs/screenshots/beheer-edities-mobiel.png"><img src="docs/screenshots/beheer-edities-mobiel.png" width="170" alt="Comparing on a phone"></a><br><sub>Comparing on a phone</sub></td></tr>
</table>

## Name of the app
Under *Settings* (⚙) → *Config* you also set the **name of the site** (next to the logo and in the PDF; default `SITE_TITLE`) and the **name of the app** and a short name (max. 12 characters, under the icon). Those are used when the site is installed on a phone or computer.

Below them you set the **name for a passkey** (max. 40 characters; empty = the name of the app, otherwise the site name). A passkey for the admin area is saved in your password manager under that name, followed by the username, for example *Halloween Hoogland (beheerder)*. That way you recognise it even when several apps run on the same domain (a beta next to the stable version on another port shares the domain). The domain is always shown as well: a site cannot change that. A new passkey gets the name straight away. An existing passkey is updated in browsers that support it (the WebAuthn Signal API, for example Chrome) as soon as you open the admin area; elsewhere add a new passkey and remove the old one. The name is part of the backups.
Without input the site name (`SITE_TITLE`) applies. An already installed app only adopts a new name after a while.

## Admin area as an app
The admin area (`/beheer`) can also be installed as its own app, with its own dark blue lantern with a cog as the icon and its own favicon, so you can tell it apart from the public map (Chrome/Edge: install icon in the address bar or *Install app*; iPhone/iPad: *Add to Home Screen*). The app opens directly at `/beheer`; push notifications for new changes use the same icon. You make a new icon with `python3 tools/make-icons.py`.

## Installing as an app and offline use

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/installatiemelding-ios.png"><img src="docs/screenshots/installatiemelding-ios.png" width="220" alt="Installing on iPhone/iPad"></a><br><sub>Installing on iPhone/iPad</sub></td><td align="center" valign="top"><a href="docs/screenshots/installatiemelding-android.png"><img src="docs/screenshots/installatiemelding-android.png" width="220" alt="Installing on Android"></a><br><sub>Installing on Android</sub></td></tr>
</table>

- **The *Install* button in the menu bar**: as long as the app is not installed, the menu bar has an **Install** button (a phone with an arrow). Nothing opens by itself. Once the app is installed and you open it as an app, the button disappears. It is there on iPhone/iPad, Android and Windows (Chrome/Edge), and in any other browser that offers installing itself (for example Chrome on macOS or Linux):
  - **Android (Chrome), Windows and other desktop browsers**: the button starts the browser's installation right away. If that is not possible (for example because you just dismissed the browser's question), a window with the steps opens: menu ⋮ → *Install app*; on Windows the install icon in the address bar or the menu → *Install app* (Edge: *Apps* → *Install this site as an app*).
  - **iPhone/iPad (Safari)**: the button opens a window with the steps. A web page cannot open Safari's own share menu and iOS has no install prompt, so you open Safari's share menu yourself (through the page menu next to the address bar → *Share*, or with the share button in the toolbar) and choose *Add to Home Screen* → *Add*.
  - Safari on macOS and Firefox cannot install from the page; the button is not shown there.
  - If you open the website in the browser while the app is already installed, the button is still shown (the browser does not tell the page); open the app itself instead.
- **Offline**: the app stores itself, the last known map data, the logo and the map tiles of the neighbourhood (and the PDF section).
  Without a connection you see the last known state (with the message *Offline*), and the PDF can still be made. Only the admin area always requires a connection.
- This only works over **HTTPS** (see `ORIGIN`). After an update of the site the app fetches the new version on the next visit.

## Deploy it yourself with Docker
You run the app on your own Docker environment (NAS, server, Raspberry Pi, VPS) with two files from this repository:

| File | What for |
| --- | --- |
| [`docker-compose.yml`](docker-compose.yml) | Describes the container: the image `ghcr.io/helmerznl/doorbell-map:latest`, the port, the `./data` folder for your data and that the settings come from `.env`. |
| [`.env.example`](.env.example) | Example of your settings. Copy it to `.env` and fill it in; `.env` contains secrets and does **not** belong in git. |

You do not have to build the code: the image is built and published automatically by [GitHub Actions](.github/workflows/docker.yml) (see the [Dockerfile](Dockerfile) for the build instructions).

**Steps**
1. Create a folder on your Docker host, for example `doorbell-map`, and download the two files:
   ```sh
   mkdir doorbell-map && cd doorbell-map
   curl -O https://raw.githubusercontent.com/helmerzNL/doorbell-map/main/docker-compose.yml
   curl -o .env https://raw.githubusercontent.com/helmerzNL/doorbell-map/main/.env.example
   ```
   (Or copy the contents of [`docker-compose.yml`](docker-compose.yml) and [`.env.example`](.env.example) by hand; save `.env.example` as `.env`.)
2. Fill in `.env`:

   | Variable | Meaning |
   | --- | --- |
   | `ORIGIN` | Optional. The full URL with which you open the site, for example `https://sintmaarten.flux76.app`; it must then be exactly the address in the browser. Empty means: the address the site is opened on (behind a reverse proxy via `X-Forwarded-Proto` and `X-Forwarded-Host`); the links in QR codes and invitations then get the address you open the admin on. Fill it in when the site should only be reachable on one address. Passkeys only work over **HTTPS** (or on `localhost`); without HTTPS you log in with a username and password. |
   | `SETUP_TOKEN` | Secret code for the very first login (the setup wizard: passkey or password). Generate one with `openssl rand -hex 12`. |
   | `SESSION_SECRET` | Key for signing sessions (at least 16 characters), for example `openssl rand -hex 32`. If you leave it empty, sessions expire at every restart. |
   | `SITE_TITLE` | Name of the site (can be changed later in the admin area). |
   | `PORT` | Port of the web server, default **9888**. |
   | `DOORBELL_MAP_TAG` | Which version runs: `latest` (stable, default), `beta` or a version number to pin (for example `v1.0.21`). With `beta` a **BETA** label appears next to the name, in the tab title and under the app icon. If this variable is still called `SINTMAARTEN_TAG` on your setup, it keeps working; rename it when convenient. |
   | `DATA_PATH` | Folder on the host for your data, default `./data` next to `docker-compose.yml`. If you run the stack through Dockge, Portainer, Komodo or Unraid, set an **absolute path** (for example `/mnt/user/appdata/doorbell-map`): otherwise `./data` lives inside the stack manager's folder, which may itself run in a container or volume. |
   | `RP_ID`, `SESSION_HOURS` | Optional; see the comments in [`.env.example`](.env.example). |
3. Start the container: `docker compose up -d`. Your data (houses, users and login details, logo, explanation, backups, the audit log `audit-log.jsonl`, and `secret.key` for MFA) is in `DATA_PATH` (default `./data`); the container restores the permissions on that folder itself (it starts briefly as root and then runs the app as user `node`).
4. For passkeys, the home-screen app and notifications: put a reverse proxy with **HTTPS** in front of the port from `PORT` (Synology: *Login Portal → Reverse Proxy*, or Nginx Proxy Manager / Traefik / Caddy). Without HTTPS the map works too, and you log in with a username and password.
5. Open `<address>/beheer` and complete the setup with the `SETUP_TOKEN`: choose a username and a passkey or password (see [Onboarding](#the-admin-area-beheer)).

**Updating:** `docker compose pull && docker compose up -d`. **Back-up:** copy the data folder (`DATA_PATH`) (or use the backups in the admin area).

**Suddenly asked for the setup code again?** Then the server finds no `db.json` in `/data`: a different, empty folder is mounted. This happens for example when you move the stack folder while `DATA_PATH` is empty, because `./data` then points to a new empty folder; your data is still in the old one. Do not complete the setup. At startup the server writes to the container log which data folder it uses and whether it found data there (`Gegevens: …`); `docker inspect <container>` shows which host folder is mounted on `/data`. Set `DATA_PATH` in `.env` to the absolute path of the folder with `db.json` (or copy the contents of the old folder into the new one with `cp -a`, with the container stopped) and start again.

> Is the GHCR package private? Make it public (GitHub → Packages → Package settings), or log in with
> `docker login ghcr.io` (username + Personal Access Token with `read:packages`).

## Beta branch
Develop new features on the **`beta`** branch, so that `main` (and so `:latest` and the releases) stays stable.
- Workflow: create a `feature/…` branch, open a PR into `beta`, test and merge there. When `beta` is good, open a PR `beta` → `main` with a clear title (it ends up in the release notes).
- Every push to `beta` makes GitHub Actions run the tests and build an image `ghcr.io/helmerznl/doorbell-map:beta` (plus a `sha` tag). There is **no** version tag, **no** release and `:latest` does not change; the app shows `x.y.z-beta` as its version.
- Testing on the NAS: a separate stack with `DOORBELL_MAP_TAG=beta` in the `.env` (this selects the image `…:beta` and turns the BETA label on), its own `container_name` in the compose file, its own port, its own `ORIGIN` and its **own `DATA_PATH`**. Do not share the data with your production stack: new versions may change the data format. Update with `docker compose pull && docker compose up -d`.
- **Promotion to `main`:** only when the owner asks, with a promotion PR `beta` → `main` and a **merge commit** (never squash), following the [promotion runbook](https://github.com/Flux76HQ/App-Guidance/blob/main/shared/guidelines/promotion-runbook.md); the working conventions are in [`AGENTS.md`](AGENTS.md). The `only-from-beta` check (`.github/workflows/pr-target.yml`) fails every other PR into `main`; the owner makes it required in the branch protection of `main`.

## Issues and pull requests
Issues and pull requests follow the forms from [App-Guidance](https://github.com/Flux76HQ/App-Guidance) (`shared/templates/github/`):
- **Issues** (`.github/ISSUE_TEMPLATE/`): bug, feature, documentation, regression, performance, chore, release checklist and *PWA / self-hosting*. Blank issues are off; questions go to Discussions, security reports to a private advisory.
- **Pull requests** (`.github/PULL_REQUEST_TEMPLATE.md`): *Summary*, *Deployment files* (changes to Compose or `.env.example` as an instruction for the operator), *Limits*, a *Change Spec* for the release notes and a checklist. The bullets under *Summary* end up in the automatic release notes.
- GitHub only shows the issue forms from the default branch.

## GitHub Actions
`.github/workflows/docker.yml` runs the tests and, on every push to `main`/`master`, builds a multi-arch image
(amd64 + arm64) to `ghcr.io/helmerznl/doorbell-map:latest`. Update on the NAS with `docker compose pull && docker compose up -d`.

## Local development
```
npm install
ORIGIN=http://localhost:9888 SETUP_TOKEN=local-test-token-1 npm start
npm test
```
You regenerate the screenshots in this README with `node tools/screenshots.js` (Playwright + Chromium and internet for the map tiles; the example data is in `tools/screenshots/`, the buildings come from OpenStreetMap © OpenStreetMap contributors). With one or more words after it you only make the screenshots with that name, for example `node tools/screenshots.js qr`.

## Security
Passkeys via WebAuthn ([SimpleWebAuthn](https://simplewebauthn.dev/)), passwords as a `scrypt` hash, two-step verification via TOTP ([otpauth](https://github.com/hectorm/otpauth)) with an encrypted secret and hashed recovery codes, session cookie `HttpOnly`/`SameSite=Strict` (over HTTPS also `Secure`) with a session epoch per user (a new password, MFA change or reset signs out the other sessions), origin check on changes and limiting of failed attempts.
User management follows [App-Guidance: user management](https://github.com/Flux76HQ/App-Guidance/blob/main/shared/guidelines/user-management.md).
Back-up: copy the `data/` folder (with `db.json` and `secret.key`). Nobody can log in any more? See [Nobody can log in any more?](#nobody-can-log-in-any-more).
