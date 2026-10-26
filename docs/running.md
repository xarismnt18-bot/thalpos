# Running it at home

[← Back to the README](../README.md)

## Start automatically

Run `install_autostart.bat` once. Thalpos then starts hidden every time you sign in to Windows, with its logs in `logs/`, and a **Thalpos** shortcut appears on the desktop.

- `restart_thalpos.bat` restarts it in the background, for example after a setup script or an update.
- `uninstall_autostart.bat` turns autostart off.

To run it in visible windows instead, use `Run_Thalpos.bat`, or the **Thalpos** icon on the desktop that `create_shortcut.bat` makes: it opens the backend and the dashboard in their own command windows and opens the dashboard in the browser as soon as it is ready. It stops a previous instance first, so it is safe to run again.

Manual start, one terminal each:

```bash
mosquitto
venv\Scripts\python main.py
cd frontend-react && npm run dev
```

The backend keeps retrying the broker, so the order doesn't matter.

## Remote access with Tailscale

Open the dashboard from your phone anywhere, without opening ports on the router:

1. Install [Tailscale](https://tailscale.com/download) on the PC and the phone and sign in with the same account.
2. Run `setup_remote.bat`. It publishes the dashboard at `https://<pc-name>.<tailnet>.ts.net/` and copies the link.

The link uses HTTPS and works only on your own Tailscale devices. The setting survives restarts; `tailscale serve reset` turns it off. The backend itself stays on `127.0.0.1`: the dashboard reaches it through the Vite proxy at `/api`.

## A laptop as the server

Thalpos stops while the PC sleeps: no alerts, no remote dashboard. The readings themselves are not lost: the sensor (firmware 3.2) keeps up to 10 hours of them and sends them when the PC wakes up, so charts and the Sleep page have no holes. `keep_awake.bat` (asks for admin) sets the plugged-in power plan so the laptop never sleeps, closing the lid does nothing and the screen turns off after 2 minutes. Battery settings are unchanged. Undo it in Settings → System → Power.
