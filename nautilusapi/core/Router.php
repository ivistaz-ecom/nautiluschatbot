<?php
// backend/core/Router.php

class Router {
    private array $routes = [];

    public function get(string $path, callable|array $handler): void {
        $this->routes[] = ['GET', $path, $handler];
    }

    public function post(string $path, callable|array $handler): void {
        $this->routes[] = ['POST', $path, $handler];
    }

    public function put(string $path, callable|array $handler): void {
        $this->routes[] = ['PUT', $path, $handler];
    }

    public function delete(string $path, callable|array $handler): void {
        $this->routes[] = ['DELETE', $path, $handler];
    }

    public function dispatch(string $method, string $uri): void {
        // Strip query string
        $uri = strtok($uri, '?');

        foreach ($this->routes as [$routeMethod, $routePath, $handler]) {
            if ($routeMethod !== $method) continue;

            $params = $this->matchPath($routePath, $uri);
            if ($params !== null) {
                $this->call($handler, $params);
                return;
            }
        }

        Response::error('Route not found', 404);
    }

    private function matchPath(string $routePath, string $uri): ?array {
        // Convert :param to named capture groups
        $pattern = preg_replace('#:([a-zA-Z_]+)#', '(?P<$1>[^/]+)', $routePath);
        $pattern = '#^' . $pattern . '$#';

        if (preg_match($pattern, $uri, $matches)) {
            return array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY);
        }
        return null;
    }

    private function call(callable|array $handler, array $params): void {
        if (is_array($handler)) {
            [$class, $method] = $handler;
            $instance = new $class();
            $instance->$method($params);
        } else {
            $handler($params);
        }
    }
}
