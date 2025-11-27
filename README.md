# Craigslist Automation Worker

A Flask-based web service for automating Craigslist posting operations using Selenium with headless Chrome.

## Features

- **POST /process-job**: Handles Craigslist posting automation
- Headless Chrome browser automation
- Craigslist account login support
- CAPTCHA detection
- Screenshot capture at each step
- JSON API responses

## Installation

### Local Development

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Run the application:
```bash
python app.py
```

### Docker

1. Build the image:
```bash
docker build -t craigslist-automation-worker .
```

2. Run the container:
```bash
docker run -p 5000:5000 craigslist-automation-worker
```

## API Endpoints

### Health Check

```
GET /health
```

Returns service health status.

### Process Job

```
POST /process-job
Content-Type: application/json
```

**Request Body:**
```json
{
    "job_id": "unique-job-identifier",
    "email": "craigslist-account@email.com",
    "password": "account-password",
    "posting": {
        "city": "newyork",
        "title": "Posting title",
        "body": "Posting body/description",
        "category": "category-code",
        "price": 100,
        "images": ["url1", "url2"]
    }
}
```

**Response:**
```json
{
    "job_id": "unique-job-identifier",
    "status": "completed",
    "steps": [
        {"step": "driver_init", "success": true},
        {"step": "login", "success": true, "details": {...}},
        {"step": "create_posting", "success": true, "details": {...}}
    ],
    "screenshots": [
        {"step": "login", "data": "base64-encoded-png"},
        {"step": "create_posting", "data": "base64-encoded-png"}
    ],
    "captcha_detected": false
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `5000` |
| `HEADLESS` | Run Chrome in headless mode | `true` |
| `FLASK_DEBUG` | Enable Flask debug mode | `false` |
| `CHROME_BIN` | Path to Chrome binary | Auto-detected |
| `CHROMEDRIVER_PATH` | Path to ChromeDriver | Auto-managed |

## Deployment

### Heroku

The included `Procfile` configures the app for Heroku deployment:

```bash
heroku create
git push heroku main
```

Note: You'll need to add a Chrome buildpack for Heroku deployment.

### Docker

Deploy using the included `Dockerfile`:

```bash
docker build -t craigslist-worker .
docker run -p 5000:5000 -e HEADLESS=true craigslist-worker
```

## Project Structure

```
├── app.py                 # Flask application with API endpoints
├── craigslist_worker.py   # Selenium automation logic
├── requirements.txt       # Python dependencies
├── Procfile              # Heroku deployment configuration
├── Dockerfile            # Docker container configuration
└── README.md             # This file
```

## License

MIT