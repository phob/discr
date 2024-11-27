# Use a smaller Node.js runtime based on Alpine Linux
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json files and install dependencies
COPY package*.json ./
RUN npm install && npm cache clean --force

# Copy the src directory and other necessary files
COPY src ./src
COPY .env ./
COPY src/bot.js ./

# Create directory for mounting channels.json
RUN mkdir -p /opt/discr

# Create directory for config files
RUN mkdir -p /usr/src/app/config && chown node:node /usr/src/app/config

# Switch to non-root user for better security
USER node

# Expose the port the app runs on (not necessary for this bot, but left for completeness)
EXPOSE 3000

# Define environment variable
ENV NODE_ENV=production

# Set the bot.js as the entrypoint
ENTRYPOINT ["node", "bot.js"]
