"""
Craigslist Worker Module
Handles Selenium automation for Craigslist posting operations.
"""

import base64
import os
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException


class CraigslistWorker:
    """Handles Craigslist posting automation via Selenium."""

    def __init__(self, headless=True):
        """Initialize the worker with Chrome options."""
        self.headless = headless
        self.driver = None

    def _create_driver(self):
        """Create and configure Chrome WebDriver."""
        chrome_options = Options()
        if self.headless:
            chrome_options.add_argument("--headless")
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument("--disable-gpu")
        chrome_options.add_argument("--window-size=1920,1080")
        chrome_options.add_argument("--disable-blink-features=AutomationControlled")
        chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
        chrome_options.add_experimental_option("useAutomationExtension", False)

        # Use Chrome binary from environment or default path
        chrome_binary = os.environ.get("CHROME_BIN")
        if chrome_binary:
            chrome_options.binary_location = chrome_binary

        # Use ChromeDriver from environment or webdriver-manager
        chromedriver_path = os.environ.get("CHROMEDRIVER_PATH")
        if chromedriver_path:
            service = Service(executable_path=chromedriver_path)
            self.driver = webdriver.Chrome(service=service, options=chrome_options)
        else:
            from webdriver_manager.chrome import ChromeDriverManager
            service = Service(ChromeDriverManager().install())
            self.driver = webdriver.Chrome(service=service, options=chrome_options)

        # Set implicit wait
        self.driver.implicitly_wait(10)
        return self.driver

    def _take_screenshot(self):
        """Capture screenshot and return as base64 encoded string."""
        if self.driver:
            screenshot = self.driver.get_screenshot_as_png()
            return base64.b64encode(screenshot).decode("utf-8")
        return None

    def _detect_captcha(self):
        """Detect if CAPTCHA is present on the page."""
        captcha_indicators = [
            "//iframe[contains(@src, 'recaptcha')]",
            "//div[contains(@class, 'g-recaptcha')]",
            "//div[contains(@class, 'captcha')]",
            "//*[contains(text(), 'CAPTCHA')]",
            "//*[contains(text(), 'captcha')]",
            "//img[contains(@src, 'captcha')]",
        ]

        for indicator in captcha_indicators:
            try:
                elements = self.driver.find_elements(By.XPATH, indicator)
                if elements:
                    return True
            except NoSuchElementException:
                continue
        return False

    def login(self, email, password):
        """
        Login to Craigslist account.

        Args:
            email: Craigslist account email
            password: Craigslist account password

        Returns:
            dict: Result containing success status and any error messages
        """
        try:
            self.driver.get("https://accounts.craigslist.org/login")
            time.sleep(2)

            # Check for CAPTCHA
            if self._detect_captcha():
                return {
                    "success": False,
                    "error": "CAPTCHA detected on login page",
                    "captcha_detected": True,
                    "screenshot": self._take_screenshot(),
                }

            # Find and fill email field
            email_field = WebDriverWait(self.driver, 10).until(
                EC.presence_of_element_located((By.ID, "inputEmailHandle"))
            )
            email_field.clear()
            email_field.send_keys(email)

            # Find and fill password field
            password_field = self.driver.find_element(By.ID, "inputPassword")
            password_field.clear()
            password_field.send_keys(password)

            # Click login button
            login_button = self.driver.find_element(By.ID, "login")
            login_button.click()

            time.sleep(3)

            # Check for CAPTCHA after login attempt
            if self._detect_captcha():
                return {
                    "success": False,
                    "error": "CAPTCHA detected after login attempt",
                    "captcha_detected": True,
                    "screenshot": self._take_screenshot(),
                }

            # Check for login errors
            try:
                error_element = self.driver.find_element(
                    By.CSS_SELECTOR, ".error, .alert-danger, [class*='error']"
                )
                if error_element.is_displayed():
                    return {
                        "success": False,
                        "error": f"Login failed: {error_element.text}",
                        "captcha_detected": False,
                        "screenshot": self._take_screenshot(),
                    }
            except NoSuchElementException:
                pass

            # Verify login success by checking URL or page content
            if "login" not in self.driver.current_url.lower():
                return {
                    "success": True,
                    "message": "Login successful",
                    "captcha_detected": False,
                    "screenshot": self._take_screenshot(),
                }

            return {
                "success": False,
                "error": "Login verification failed",
                "captcha_detected": False,
                "screenshot": self._take_screenshot(),
            }

        except TimeoutException:
            return {
                "success": False,
                "error": "Timeout waiting for login page elements",
                "captcha_detected": False,
                "screenshot": self._take_screenshot(),
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "captcha_detected": False,
                "screenshot": self._take_screenshot(),
            }

    def create_posting(self, posting_data):
        """
        Initiate a new Craigslist posting.

        This is a simplified implementation that navigates to the posting page
        and initiates the posting flow. The full multi-step posting process
        (category selection, form filling, image upload, etc.) would need to
        be implemented based on specific requirements.

        Args:
            posting_data: dict containing posting details (title, body, category, etc.)

        Returns:
            dict: Result containing success status, current URL, and any errors
        """
        try:
            # Navigate to post creation page
            city = posting_data.get("city", "newyork")
            self.driver.get(f"https://{city}.craigslist.org/")
            time.sleep(2)

            # Check for CAPTCHA
            if self._detect_captcha():
                return {
                    "success": False,
                    "error": "CAPTCHA detected on posting page",
                    "captcha_detected": True,
                    "screenshot": self._take_screenshot(),
                }

            # Click post to classifieds link
            try:
                post_link = WebDriverWait(self.driver, 10).until(
                    EC.element_to_be_clickable((By.ID, "post"))
                )
                post_link.click()
            except TimeoutException:
                # Try alternative selector
                post_link = self.driver.find_element(
                    By.XPATH, "//a[contains(text(), 'post')]"
                )
                post_link.click()

            time.sleep(2)

            # Return success for posting initiation
            # Full implementation would continue with category selection,
            # form filling, and submission steps
            return {
                "success": True,
                "message": "Posting page navigation successful",
                "captcha_detected": False,
                "screenshot": self._take_screenshot(),
                "current_url": self.driver.current_url,
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "captcha_detected": self._detect_captcha(),
                "screenshot": self._take_screenshot(),
            }

    def process_job(self, job_data):
        """
        Process a complete job (login + posting).

        Args:
            job_data: dict containing credentials and posting details

        Returns:
            dict: Complete job result with all status information
        """
        result = {
            "job_id": job_data.get("job_id"),
            "status": "processing",
            "steps": [],
            "screenshots": [],
        }

        try:
            # Initialize driver
            self._create_driver()
            result["steps"].append({"step": "driver_init", "success": True})

            # Login if credentials provided
            if job_data.get("email") and job_data.get("password"):
                login_result = self.login(
                    job_data["email"], job_data["password"]
                )
                result["steps"].append({
                    "step": "login",
                    "success": login_result["success"],
                    "details": login_result,
                })
                if login_result.get("screenshot"):
                    result["screenshots"].append({
                        "step": "login",
                        "data": login_result["screenshot"],
                    })

                if not login_result["success"]:
                    result["status"] = "failed"
                    result["error"] = login_result.get("error")
                    result["captcha_detected"] = login_result.get(
                        "captcha_detected", False
                    )
                    return result

            # Create posting if posting data provided
            if job_data.get("posting"):
                posting_result = self.create_posting(job_data["posting"])
                result["steps"].append({
                    "step": "create_posting",
                    "success": posting_result["success"],
                    "details": posting_result,
                })
                if posting_result.get("screenshot"):
                    result["screenshots"].append({
                        "step": "create_posting",
                        "data": posting_result["screenshot"],
                    })

                if not posting_result["success"]:
                    result["status"] = "failed"
                    result["error"] = posting_result.get("error")
                    result["captcha_detected"] = posting_result.get(
                        "captcha_detected", False
                    )
                    return result

            result["status"] = "completed"
            return result

        except Exception as e:
            result["status"] = "error"
            result["error"] = str(e)
            if self.driver:
                result["screenshots"].append({
                    "step": "error",
                    "data": self._take_screenshot(),
                })
            return result

        finally:
            self.cleanup()

    def cleanup(self):
        """Clean up resources."""
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None
