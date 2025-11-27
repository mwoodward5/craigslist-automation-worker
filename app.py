"""
Flask application for Craigslist automation worker.
Provides API endpoints for processing Craigslist posting jobs.
"""

import os
from flask import Flask, request, jsonify
from craigslist_worker import CraigslistWorker

app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health_check():
    """Health check endpoint."""
    return jsonify({"status": "healthy", "service": "craigslist-automation-worker"})


@app.route("/process-job", methods=["POST"])
def process_job():
    """
    Process a Craigslist posting job.

    Expected JSON payload:
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

    Returns:
    {
        "job_id": "unique-job-identifier",
        "status": "completed|failed|error",
        "steps": [...],
        "screenshots": [...],
        "error": "error message if failed",
        "captcha_detected": true|false
    }
    """
    if not request.is_json:
        return jsonify({
            "status": "error",
            "error": "Request must be JSON"
        }), 400

    job_data = request.get_json()

    if job_data is None:
        return jsonify({
            "status": "error",
            "error": "Empty request body"
        }), 400

    # Validate required fields
    if not job_data.get("job_id"):
        return jsonify({
            "status": "error",
            "error": "job_id is required"
        }), 400

    # Process the job
    headless = os.environ.get("HEADLESS", "true").lower() == "true"
    worker = CraigslistWorker(headless=headless)

    try:
        result = worker.process_job(job_data)
        status_code = 200 if result.get("status") == "completed" else 422
        return jsonify(result), status_code
    except Exception as e:
        return jsonify({
            "job_id": job_data.get("job_id"),
            "status": "error",
            "error": str(e)
        }), 500


@app.errorhandler(404)
def not_found(error):
    """Handle 404 errors."""
    return jsonify({"status": "error", "error": "Not found"}), 404


@app.errorhandler(500)
def internal_error(error):
    """Handle 500 errors."""
    return jsonify({"status": "error", "error": "Internal server error"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
