# Step 1: Start with a lean, official Python base image.
# We use Debian "slim" as a base because it's smaller than the full version.
FROM python:3.11-slim

# Step 2: Set the working directory inside the container.
WORKDIR /app

# Step 3: Install system dependencies.
# We need to install the Chromium browser and its matching Selenium driver.
# This is the most critical step for making Selenium work headlessly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-driver \
    && rm -rf /var/lib/apt/lists/*

# Step 4: Install Python dependencies.
# We copy requirements.txt first to take advantage of Docker's layer caching.
# This makes subsequent builds much faster if the requirements haven't changed.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Step 5: Copy your application code into the container.
COPY . .

# Step 6: Expose the port your Flask web server will run on.
# Render will use this to route traffic for health checks.
EXPOSE 8080

# Step 7: Define the command to run when the container starts.
CMD ["python", "drednot_bot.py"]
