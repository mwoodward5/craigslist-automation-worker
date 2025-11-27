from flask import Flask, request, jsonify
import os

app = Flask(__name__)

@app.route('/')
def home():
    return jsonify({
        'status': 'online',
        'service': 'Craigslist Automation Worker',
        'version': '1.0.0'
    })

@app.route('/health')
def health():
    return jsonify({'status': 'healthy'})

@app.route('/process-job', methods=['POST'])
def process_job():
    job_data = request.get_json()
    return jsonify({
        'status': 'queued',
        'jobId': job_data.get('jobId', 'unknown'),
        'message': 'Job received - Selenium automation coming soon'
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
