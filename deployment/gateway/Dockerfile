# Forward the public API to the internal backend through Direct VPC egress.
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY default.conf backend.inc /etc/nginx/conf.d/
RUN nginx -t
EXPOSE 8080
