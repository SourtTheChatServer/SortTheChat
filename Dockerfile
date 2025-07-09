# Step 1: Start from an official base image.
# This image is provided by the Puppeteer team. It includes Node.js and all the
# complex system libraries that Chrome needs to run. This saves us a ton of work.
FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Step 2: Set the working directory inside the container.
# All subsequent commands will run from this path.
WORKDIR /usr/src/app

# Step 3: Copy the package files and install dependencies.
# We copy package.json and package-lock.json *first*. Docker caches layers,
# so if our source code changes but our dependencies don't, Docker can skip
# the time-consuming `npm install` step on future builds.
COPY package*.json ./
RUN npm install

# Step 4: Copy the rest of our application's source code.
# This copies bot.js and any other files into the working directory.
COPY . .

# Step 5: Define the command to run when the container starts.
# This tells Render to run our bot script with Node.js.
CMD [ "node", "bot.js" ]
