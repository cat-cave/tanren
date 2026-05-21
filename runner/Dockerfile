FROM debian:trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    nodejs \
    npm \
    openssh-server \
    python3 \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash --uid 1000 tanren \
  && mkdir -p /run/sshd /workspace /home/tanren/.ssh \
  && chown -R tanren:tanren /workspace /home/tanren/.ssh \
  && chmod 700 /home/tanren/.ssh

RUN ssh-keygen -A \
  && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
  && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config

COPY runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
