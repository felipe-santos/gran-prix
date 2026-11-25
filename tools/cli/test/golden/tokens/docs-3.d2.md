Fernwick stores one preference cookie. Accept

[Fernwick Docs](/) Menu

**Relay guide**

*   [Behind a proxy](#)
*   [Certificates](#)
*   [Metrics](#)

# Running the Fernwick relay behind a proxy

The relay forwards sensor readings from a greenhouse controller to your own server. When a corporate proxy sits in between, the relay needs to know how to reach it and which hosts to skip.

## Pointing the relay at the proxy

The proxy address can be given on the command line, in the environment, or in the configuration file. All three forms are shown below.

Command line Environment Config file

    fernwick-relay --proxy http://gate.example.test:3128 --no-proxy 10.0.0.0/8

## Troubleshooting

The relay starts but no readings arrive Certificates are rejected Where are the logs written?

On Linux the relay logs to the system journal. On other systems it writes `relay.log` next to the executable.

## Limits

### Payload size

### Retry schedule

### Queue length

The local queue holds the last two thousand readings and drops the oldest first.

## Release notes

Earlier versions behaved differently in a few places. The notes for each are kept on this page.

Send feedback

Fernwick Docs are published under a permissive licence.

[Report a docs problem](#)