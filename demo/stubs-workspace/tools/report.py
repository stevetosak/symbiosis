"""A small report on a cart file: one item per line, "name,category,cents,quantity"."""

import sys

SEPARATOR = ","


def parse_line(line):
    """One line as a dict with name, category, cents and quantity; None for a bad line."""
    # TODO(pi)
    raise NotImplementedError


# Your turn: end the comment below with helpi! and pause.

# a function that reads a cart file and returns its parsed items, skipping bad lines


if __name__ == "__main__":
    print(sys.argv[1:])
