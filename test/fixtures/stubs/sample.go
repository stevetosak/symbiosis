package demo

import (
	"fmt"
	"os"
)

const limit = 10

// SumFile sums the numbers in a file, one per line.
func SumFile(path string) (int, error) {
	// TODO(pi)
	panic("not written")
}

func get(key string) int {
	fmt.Println(key, os.Args)
	return limit
}
