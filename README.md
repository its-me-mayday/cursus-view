# Cursus View

Minimal React Native frontend for the Cursus backend.

## Run

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm start
```

The default API URL is `http://localhost:8085`, matching the backend Docker Compose setup.
If you run the backend with `make run`, use `http://localhost:8080` in the app settings.

Android emulator note: use `http://10.0.2.2:8085` or `http://10.0.2.2:8080`.

## Backend

Start Cursus from the sibling repository:

```bash
cd ../cursus
docker compose up
```

