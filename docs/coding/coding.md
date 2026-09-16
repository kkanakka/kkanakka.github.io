---
title: "Coding Problems"
slug: /coding/coding
sidebar_position: 1
sidebar_label: "Coding Problems"
description: "Coding Problems"
---

<!-- DIAGRAM:START -->

## How it works

<img src="/diagrams/coding/sequence.svg" alt="How it works — coding" class="doc-diagram doc-diagram-seq" />

<!-- DIAGRAM:END -->
A visual guide to solving coding interview problems with step-by-step traces, flowcharts, and complexity analysis.

[Home](/) [Linux Internals](/docs/linux) [System Design Hub](/docs/foundations)

<a id="top"></a>

## Problems

1.  [Contains Duplicate — hasDuplicate()](#contains-duplicate) Easy
2.  [Valid Anagram — isAnagram()](#valid-anagram) Easy
3.  [Two Sum — twoSum()](#two-sum) Easy
4.  [Group Anagrams — groupAnagrams()](#group-anagrams) Medium
5.  [Top K Frequent Elements — topKFrequent()](#top-k-frequent) Medium
6.  [Encode and Decode Strings — encode() / decode()](#encode-decode-strings) Medium
7.  [Product of Array Except Self — productExceptSelf()](#product-except-self) Medium
8.  [Longest Consecutive Sequence — longestConsecutive()](#longest-consecutive) Medium

<a id="contains-duplicate"></a>

Problem 1

## Contains Duplicate

hasDuplicate() — Using a HashSet Approach

### Problem Statement

Given an integer array `nums`, return `true` if any value appears more than once in the array, otherwise return `false`.

### Solution Code

```python
Python
def hasDuplicate(self, nums: List[int]) -> bool:
    seen = set()
    for num in nums:
        if num in seen:
            return True
        seen.add(num)
    return False
```

### How It Works

The algorithm uses a **HashSet** to track numbers already seen. For each number in the array, it checks if the number exists in the set. If yes, a duplicate is found. If no, the number is added to the set. This gives **O(n)** time and **O(n)** space complexity.

### Algorithm Flowchart

Decision flow for each element

START

▼

Initialize seen = { }

▼

Get next num from array

▼

◆ Is num in seen? ◆

YES

▼

return True

NO

▼

Add num to seen

↰ Loop back

▼

All done → return False

### Step-by-Step Trace

Example: `nums = [1, 2, 3, 3]`

| Step | num | seen (before) | In seen? | Action |
| --- | --- | --- | --- | --- |
| 1 | 1 | { } | No | Add 1 |
| 2 | 2 | { 1 } | No | Add 2 |
| 3 | 3 | { 1, 2 } | No | Add 3 |
| 4 | 3 | { 1, 2, 3 } | **YES!** | return True |

### Complexity Analysis

| Metric | Value | Why |
| --- | --- | --- |
| Time | **O(n)** | Single pass through array |
| Space | **O(n)** | HashSet stores up to n items |

### Key Insight

**HashSet lookup is O(1) on average.** This makes the set-based approach far more efficient than a brute-force O(n²) nested loop or an O(n log n) sort-then-scan approach. We trade space for speed.

[↑ Back to top](#top)

<a id="valid-anagram"></a>

Problem 2

## Valid Anagram

isAnagram() — Using a HashMap / Counter Approach

### Problem Statement

Given two strings `s` and `t`, return `true` if the two strings are anagrams of each other, otherwise return `false`.

An **anagram** is a string that contains the exact same characters as another string, but the order of the characters can be different.

### Solution Code

```python
Python
def isAnagram(self, s: str, t: str) -> bool:
    if len(s) != len(t):
        return False

    count = {}
    for i in range(len(s)):
        count[s[i]] = count.get(s[i], 0) + 1
        count[t[i]] = count.get(t[i], 0) - 1

    for val in count.values():
        if val != 0:
            return False
    return True
```

### How It Works

The algorithm uses a single **HashMap** (dictionary) to count character frequencies. It increments the count for each character in `s` and decrements for each character in `t`. If all counts end up at zero, the strings are anagrams. A quick length check at the start provides an early exit for obvious non-matches.

### Algorithm Flowchart

Decision flow

START

▼

◆ len(s) == len(t)? ◆

YES

▼

For each index i:  
count\[s\[i\]\] += 1  
count\[t\[i\]\] -= 1

NO

▶

return False

▼

◆ All counts == 0? ◆

YES

▼

return True

NO

▼

return False

### Step-by-Step Trace

#### Example 1: s = "racecar", t = "carrace"

| i | s\[i\] | t\[i\] | Action | count |
| --- | --- | --- | --- | --- |
| 0 | r | c | +r, -c | {r:1, c:-1} |
| 1 | a | a | +a, -a | {r:1, c:-1, a:0} |
| 2 | c | r | +c, -r | {r:0, c:0, a:0} |
| 3 | e | r | +e, -r | {r:-1, c:0, a:0, e:1} |
| 4 | c | a | +c, -a | {r:-1, c:1, a:-1, e:1} |
| 5 | a | c | +a, -c | {r:-1, c:0, a:0, e:1} |
| 6 | r | e | +r, -e | {r:0, c:0, a:0, e:0} |

All counts are 0 → **return True** (they are anagrams!)

#### Example 2: s = "jar", t = "jam"

| i | s\[i\] | t\[i\] | Action | count |
| --- | --- | --- | --- | --- |
| 0 | j | j | +j, -j | {j:0} |
| 1 | a | a | +a, -a | {j:0, a:0} |
| 2 | r | m | +r, -m | {j:0, a:0, r:1, m:-1} |

r:1 and m:-1 are not 0 → **return False** (not anagrams)

### Complexity Analysis

| Metric | Value | Why |
| --- | --- | --- |
| Time | **O(n)** | Single pass through both strings |
| Space | **O(1)** | At most 26 lowercase letters |

### Key Insight

**Increment and decrement in one pass.** By adding for s and subtracting for t in the same loop, we avoid building two separate frequency maps. If every character cancels out to zero, the strings are perfect anagrams. Space is O(1) since there are at most 26 lowercase English letters.

[↑ Back to top](#top)

<a id="two-sum"></a>

Problem 3

## Two Sum

twoSum() — Brute-Force Two-Pointer Scan

### Problem Statement

Given an array of integers `nums` and an integer `target`, return the indices `i` and `j` such that `nums[i] + nums[j] == target` and `i != j`.

You may assume that every input has exactly one pair of indices. Return the answer with the smaller index first.

### Solution Code

```python
Python
def twoSum(self, nums: List[int], target: int) -> List[int]:
    first = 0
    while first < len(nums):
        last = len(nums) - 1
        while first < last:
            if nums[first] + nums[last] == target:
                return [first, last]
            else:
                last = last - 1
        first = first + 1
```

### How It Works

This solution uses a **brute-force approach** with two nested loops. The outer pointer (`first`) starts at index 0 and moves forward. The inner pointer (`last`) starts at the end and scans backward toward `first`. For each pair, it checks if `nums[first] + nums[last]` equals the target. Once found, it returns the pair of indices immediately.

### Algorithm Flowchart

Two-pointer scanning logic

START

▼

first = 0

▼

◆ first < len(nums)? ◆

▼

last = len(nums) - 1

▼

◆ nums\[first\] + nums\[last\] == target? ◆

YES

▼

return \[first, last\]

NO

▼

last -= 1

↰ inner loop

If inner loop exhausts → first += 1, reset last → ↰ outer loop

### Step-by-Step Trace

#### Example 1: nums = \[3, 4, 5, 6\], target = 7

| first | last | nums\[first\] | nums\[last\] | Sum | Result |
| --- | --- | --- | --- | --- | --- |
| 0 | 3 | 3 | 6 | 3+6 = 9 | ✘ ≠ 7 |
| 0 | 2 | 3 | 5 | 3+5 = 8 | ✘ ≠ 7 |
| 0 | 1 | 3 | 4 | 3+4 = 7 | **✔ == 7!** |

Match found at first=0, last=1 → **return \[0, 1\]**

#### Example 2: nums = \[4, 5, 6\], target = 10

| first | last | nums\[first\] | nums\[last\] | Sum | Result |
| --- | --- | --- | --- | --- | --- |
| 0 | 2 | 4 | 6 | 4+6 = 10 | **✔ == 10!** |

Match found immediately at first=0, last=2 → **return \[0, 2\]**

### Complexity Analysis

| Metric | Value | Why |
| --- | --- | --- |
| Time | **O(n²)** | Nested loops check all pairs |
| Space | **O(1)** | No extra data structures used |

### Key Insight

**This brute-force works but can be optimized!** The nested loop approach is O(n²). A HashMap-based solution can solve this in O(n) by storing each number's index as you iterate. For each `num`, check if `(target - num)` is already in the map. If so, you instantly have both indices.

**HashMap approach:** For each num, compute `complement = target - num`. If complement is in the map, return both indices. Otherwise, store `num:index` and continue.

[↑ Back to top](#top)

<a id="group-anagrams"></a>

Problem 4

## Group Anagrams

groupAnagrams() — Sorted Key + HashMap Approach

### Problem Statement

Given an array of strings `strs`, group all anagrams together into sublists. You may return the output in any order.

An **anagram** is a string formed by rearranging the letters of another string, using all the original letters exactly once.

### Solution Code

```python
Python
from collections import defaultdict

def groupAnagrams(self, strs: List[str]) -> List[List[str]]:
    anagram_map = defaultdict(list)

    for s in strs:
        key = "".join(sorted(s))
        anagram_map[key].append(s)

    return list(anagram_map.values())
```

### How It Works

The core idea is that all anagrams, when sorted, produce the **same string**. For example, both "eat" and "tea" become "aet" when sorted. This sorted string acts as a **fingerprint (key)** in a HashMap.

The algorithm iterates through each word, sorts its characters to create a key, and appends the original word to the list mapped to that key. At the end, each key's list contains all words that are anagrams of each other.

### Algorithm Flowchart

Grouping logic for each word

START

▼

anagram\_map = { }

▼

Get next word s from strs

▼

Sort characters of s  
key = "".join(sorted(s))

▼

Append s to map\[key\]  
anagram\_map\[key\].append(s)

↰ Loop back for next word

▼

Return map.values()

### The Sorting Fingerprint

Anagrams share the same sorted key — this is what groups them together:

| Word |  | Sorted Key | Group |
| --- | --- | --- | --- |
| "eat" | → | "aet" | A |
| "tea" | → | "aet" | A |
| "ate" | → | "aet" | A |
| "tan" | → | "ant" | B |
| "nat" | → | "ant" | B |
| "bat" | → | "abt" | C |

### Step-by-Step Trace

Example: `strs = ["eat", "tea", "tan", "ate", "nat", "bat"]`

| Step | Word | Key | anagram\_map state |
| --- | --- | --- | --- |
| 1 | "eat" | "aet" | { "aet": \["eat"\] } |
| 2 | "tea" | "aet" | { "aet": \["eat","tea"\] } |
| 3 | "tan" | "ant" | { "aet": \["eat","tea"\], "ant": \["tan"\] } |
| 4 | "ate" | "aet" | { "aet": \["eat","tea","ate"\], "ant": \["tan"\] } |
| 5 | "nat" | "ant" | { "aet": \["eat","tea","ate"\], "ant": \["tan","nat"\] } |
| 6 | "bat" | "abt" | { "aet": \[...\], "ant": \[...\], "abt": \["bat"\] } |

**Final output:**

| Group | Values |
| --- | --- |
| Group A | \["eat", "tea", "ate"\] |
| Group B | \["tan", "nat"\] |
| Group C | \["bat"\] |

### Complexity Analysis

| Metric | Value | Why |
| --- | --- | --- |
| Time | **O(n · k log k)** | Sort each of n strings of avg length k |
| Space | **O(n · k)** | Store all strings in the map |

### Key Insight

**Sorting creates a canonical form for comparison.** By sorting each string, we transform the grouping problem into a simple equality check. All anagrams collapse to the same sorted key, making the HashMap do the heavy lifting of grouping automatically.

**Alternative:** Instead of sorting (O(k log k) per word), you can use a character count array of 26 zeros as the key, achieving O(n · k) time. Convert counts to a tuple for hashability.

[↑ Back to top](#top)

<a id="top-k-frequent"></a>

Problem 5

## Top K Frequent Elements

topKFrequent() — Count + Sort Approach

### Problem Statement

Given an integer array `nums` and an integer `k`, return the `k` most frequent elements within the array.

The test cases are generated such that the answer is always unique. You may return the output in any order.

### Solution Code

```python
Python
def topKFrequent(self, nums: List[int], k: int) -> List[int]:
    count = {}
    first = 0
    while first < len(nums):
        count[nums[first]] = count.get(nums[first], 0) + 1
        first = first + 1

    sorted_count = dict(
        sorted(count.items(), key=lambda x: x[1], reverse=True)
    )
    return list(
        dict(tuple(sorted_count.items())[:k]).keys()
    )
```

### How It Works

This solution breaks the problem into **two clear phases**:

1.  **Count Phase:** Iterate through `nums` using a while loop, building a HashMap where each key is a number and its value is how many times it appears.
2.  **Sort Phase:** Sort the HashMap entries by frequency in descending order (highest count first), then slice the first `k` keys as the result.

### Algorithm Flowchart

Two-phase logic

START

▼

count = { }, first = 0

▼

PHASE 1: COUNT FREQUENCIES

For each nums\[first\]:  
count\[nums\[first\]\] += 1  
first += 1

▼

PHASE 2: SORT + PICK TOP K

Sort count by value (desc)

▼

Take first k keys

▼

Return result list

### Step-by-Step Trace

#### Example 1: nums = \[1, 2, 2, 3, 3, 3\], k = 2

**Phase 1 — Counting Frequencies**

| first | nums\[first\] | Action | count |
| --- | --- | --- | --- |
| 0 | 1 | +1 | {1: 1} |
| 1 | 2 | +2 | {1: 1, 2: 1} |
| 2 | 2 | 2++ | {1: 1, 2: 2} |
| 3 | 3 | +3 | {1: 1, 2: 2, 3: 1} |
| 4 | 3 | 3++ | {1: 1, 2: 2, 3: 2} |
| 5 | 3 | 3++ | {1: 1, 2: 2, 3: 3} |

**Phase 2 — Sort by Frequency (Descending)**

| Rank | Number | Frequency | In top k=2? |
| --- | --- | --- | --- |
| 1st | 3 | 3 | **✔ SELECTED** |
| 2nd | 2 | 2 | **✔ SELECTED** |
| 3rd | 1 | 1 | ✘ SKIPPED |

Output: **\[3, 2\]** (or \[2, 3\] — order doesn't matter)

#### Example 2: nums = \[7, 7\], k = 1

| Number | Frequency | Rank | In top k=1? |
| --- | --- | --- | --- |
| 7 | 2 | 1st | **✔ SELECTED** |

Output: **\[7\]**

#### Example 3: nums = \[4, 5, 6, 7, 8, 8, 9, 4\], k = 2

After Phase 1 — Frequency count:

| Number | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- |
| **Count** | 2 | 1 | 1 | 1 | 2 | 1 |

After Phase 2 — Sorted by frequency:

| Rank | Number | Frequency | In top k=2? |
| --- | --- | --- | --- |
| 1st | 4 | 2 | **✔ SELECTED** |
| 2nd | 8 | 2 | **✔ SELECTED** |
| 3rd–6th | 5, 6, 7, 9 | 1 each | ✘ SKIPPED |

Output: **\[4, 8\]**

### Complexity Analysis

| Metric | Value | Why |
| --- | --- | --- |
| Time | **O(n log n)** | Sorting the frequency map |
| Space | **O(n)** | HashMap + sorted copy |

### Key Insight

**Two phases: Count, then Rank.** This solution uses sorting to rank, which gives O(n log n). The counting phase is always O(n). The bottleneck is the sort.

**Can we do better? Yes — Bucket Sort!** Create an array of size n+1 where index i holds numbers with frequency i. Walk backward from n to collect k elements. This achieves O(n) time by avoiding sorting entirely.

[↑ Back to top](#top)

<a id="encode-decode-strings"></a>

Problem 6

## Encode and Decode Strings

encode() / decode() — Length-Prefixed Delimiter Protocol

### Problem Statement

Design an algorithm to encode a list of strings to a single string. The encoded string is then sent over the network and is decoded back to the original list of strings.

Machine 1 (sender) calls `encode(strs)` to produce a single string. Machine 2 (receiver) calls `decode(s)` to recover the original list. The decoded output must exactly match the original input.

### Constraints

-   `0 <= strs.length < 100`
-   `0 <= strs[i].length < 200`
-   `strs[i]` contains any possible characters out of 256 valid ASCII characters

### Solution Code

```python
Python
def encode(self, strs: List[str]) -> str:
    encoded_string = ""
    for i in strs:
        length_of_word = len(i)
        encoded_string = encoded_string + "#" + str(length_of_word) + "$" + i
    return encoded_string

def decode(self, s: str) -> List[str]:
    decoded_list = []
    i = 0
    while i < len(s):
        if s[i] == "#":
            j = i + 1
            while s[j] != "$":
                j = j + 1
            length_word = int(s[i+1:j])
            word_start = j + 1
            word_end = word_start + length_word
            word = s[word_start:word_end]
            decoded_list.append(word)
            i = word_end
        else:
            i = i + 1
    return decoded_list
```

### How It Works

The algorithm uses a **length-prefixed delimiter protocol**. Each string is encoded as `#length$string`, where `#` marks the start, `length` is the character count, and `$` separates the length from the actual content. During decoding, we read the length first, then extract exactly that many characters — so it doesn't matter if the string itself contains `#`, `$`, or any other special character.

### The Encoding Format

Each string `word` of length `n` becomes:

#n$word

# = start marker n = length of word $ = end-of-length marker word = raw content

### Algorithm Flowchart — Encode

Encoding: list of strings → single string

START

▼

encoded\_string = ""

▼

Get next word from strs

▼

Append "#" + len(word) + "$" + word  
to encoded\_string

↰ Loop for next word

▼

Return encoded\_string

### Algorithm Flowchart — Decode

Decoding: single string → list of strings

START

▼

i = 0, decoded\_list = \[ \]

▼

◆ i < len(s)? ◆

YES

▼

◆ s\[i\] == "#"? ◆

YES

▼

Scan j from i+1 until s\[j\] == "$"

▼

length = int(s\[i+1 : j\])

▼

word = s\[j+1 : j+1+length\]

▼

Append word to decoded\_list

▼

i = j + 1 + length

↰ Loop back

NO (done)

▼

Return decoded\_list

### Step-by-Step Trace — Encode

Example: `strs = ["Hello", "World"]`

| Step | Word | len(word) | Appended | encoded\_string so far |
| --- | --- | --- | --- | --- |
| 1 | "Hello" | 5 | `#5$Hello` | `#5$Hello` |
| 2 | "World" | 5 | `#5$World` | `#5$Hello#5$World` |

Final encoded string: `"#5$Hello#5$World"`

### Step-by-Step Trace — Decode

Input: `s = "#5$Hello#5$World"`

| Step | i | s\[i\] | Scan j | Length | Extracted Word | New i | decoded\_list |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | # | j=1→2 (s\[2\]="$") | int("5") = 5 | s\[3:8\] = "Hello" | 8 | \["Hello"\] |
| 2 | 8 | # | j=9→10 (s\[10\]="$") | int("5") = 5 | s\[11:16\] = "World" | 16 | \["Hello", "World"\] |

i = 16 = len(s) → loop ends. Output: **\["Hello", "World"\]**

### Edge Case: Empty String

Input: `strs = [""]`

| Step | Word | len(word) | Encoded |
| --- | --- | --- | --- |
| 1 | "" | 0 | `#0$` |

Decoding `"#0$"`: length = 0, so word = s\[3:3\] = "" (empty string). Works correctly.

### Edge Case: Strings Containing Delimiters

Input: `strs = ["#5$trick", "a$b#c"]`

| Step | Word | len | Encoded Segment |
| --- | --- | --- | --- |
| 1 | "#5$trick" | 8 | `#8$#5$trick` |
| 2 | "a$b#c" | 5 | `#5$a$b#c` |

Full encoded: `"#8$#5$trick#5$a$b#c"`

Decoding reads **length first**, then grabs exactly that many characters — so embedded `#` and `$` inside the word content are harmless.

### Visual: Wire Format

How the encoded string looks on the wire

Input: `["Hi", "!", "Bye"]`

#2$Hi#1$!#3$Bye

### Complexity Analysis

| Metric | Value | Why |
| --- | --- | --- |
| Time (encode) | **O(n)** | Single pass through all strings, n = total characters |
| Time (decode) | **O(n)** | Single pass through encoded string |
| Space | **O(n)** | Output string / list stores all original data |

### Key Insight

**Length-prefix makes any delimiter safe.** Because we read the length *before* extracting the word, we know exactly where the word ends. The word content is never scanned for delimiters — we jump over it by length. This means the strings can contain `#`, `$`, newlines, or any of the 256 ASCII characters without breaking the protocol.

**This is the same idea behind real network protocols!** HTTP uses `Content-Length` headers, TCP uses length-prefixed frames, and Protocol Buffers use varint-encoded lengths — all for the same reason: length-prefixing is the most robust way to frame variable-length data.

[↑ Back to top](#top)

<a id="product-except-self"></a>

Problem 7

## Product of Array Except Self

productExceptSelf() — Brute-Force Exclude-and-Multiply

### Problem Statement

Given an integer array `nums`, return an array `output` where `output[i]` is the product of all the elements of `nums` except `nums[i]`.

Each product is guaranteed to fit in a 32-bit integer.

### Constraints

-   `2 <= nums.length <= 1000`
-   `-20 <= nums[i] <= 20`

### Solution Code (Brute-Force)

```python
Python
def productExceptSelf(self, nums: List[int]) -> List[int]:
    length = len(nums)
    i = 0
    output = []
    while i < length:
        result = 1
        new_list = nums[:i] + nums[i + 1:]
        for x in new_list:
            result = result * x
        output.append(result)
        i = i + 1
    return output
```

### How It Works

For each index `i`, the algorithm creates a **new list excluding `nums[i]`** by concatenating the left slice `nums[:i]` and the right slice `nums[i+1:]`. It then multiplies all elements in this new list to get the product. This is straightforward but has O(n²) time complexity.

### Algorithm Flowchart

Brute-force: exclude each element and multiply the rest

START

▼

i = 0, output = \[ \]

▼

◆ i < length? ◆

YES

▼

new\_list = nums\[:i\] + nums\[i+1:\]  
(everything except nums\[i\])

▼

result = multiply all in new\_list

▼

output.append(result)  
i += 1

↰ Loop back

NO

▼

Return output

### Step-by-Step Trace

#### Example 1: nums = \[1, 2, 4, 6\]

| i | Excluded | new\_list | Product | output |
| --- | --- | --- | --- | --- |
| 0 | 1 | \[2, 4, 6\] | 2 × 4 × 6 = **48** | \[48\] |
| 1 | 2 | \[1, 4, 6\] | 1 × 4 × 6 = **24** | \[48, 24\] |
| 2 | 4 | \[1, 2, 6\] | 1 × 2 × 6 = **12** | \[48, 24, 12\] |
| 3 | 6 | \[1, 2, 4\] | 1 × 2 × 4 = **8** | \[48, 24, 12, 8\] |

Output: **\[48, 24, 12, 8\]**

#### Example 2: nums = \[-1, 0, 1, 2, 3\]

| i | Excluded | new\_list | Product | output |
| --- | --- | --- | --- | --- |
| 0 | \-1 | \[0, 1, 2, 3\] | 0 × 1 × 2 × 3 = **0** | \[0\] |
| 1 | 0 | \[-1, 1, 2, 3\] | \-1 × 1 × 2 × 3 = **\-6** | \[0, -6\] |
| 2 | 1 | \[-1, 0, 2, 3\] | \-1 × 0 × 2 × 3 = **0** | \[0, -6, 0\] |
| 3 | 2 | \[-1, 0, 1, 3\] | \-1 × 0 × 1 × 3 = **0** | \[0, -6, 0, 0\] |
| 4 | 3 | \[-1, 0, 1, 2\] | \-1 × 0 × 1 × 2 = **0** | \[0, -6, 0, 0, 0\] |

Output: **\[0, -6, 0, 0, 0\]**

### Complexity Analysis (Brute-Force)

| Metric | Value | Why |
| --- | --- | --- |
| Time | **O(n²)** | For each of n elements, multiply n-1 others |
| Space | **O(n)** | new\_list created each iteration + output array |

### Optimal O(n) Approach — Prefix × Suffix

The key insight: `output[i] = (product of everything LEFT of i) × (product of everything RIGHT of i)`. We can compute this in two passes without division.

```python
Python — O(n)
def productExceptSelf(self, nums: list[int]) -> list[int]:
    length = len(nums)
    output = [1] * length

    # --- PASS 1: Calculate Products to the LEFT ---
    prefix = 1
    for i in range(length):
        output[i] = prefix      # Set current spot to the product of its left neighbors
        prefix *= nums[i]       # Update prefix to include current number for next index

    # At this point, if nums = [1, 2, 3, 4], output = [1, 1, 2, 6]

    # --- PASS 2: Calculate Products to the RIGHT ---
    suffix = 1
    for i in range(length - 1, -1, -1):
        output[i] *= suffix     # Multiply the "Left" product (already there) by the "Right" product
        suffix *= nums[i]       # Update suffix to include current number for next index

    return output
```

### Optimal Flowchart — Two-Pass

O(n): Prefix pass (→) then Suffix pass (←)

START

▼

output = \[1, 1, 1, ..., 1\]

▼

PASS 1: PREFIX (left → right)

prefix = 1  
For i = 0 to n-1:  
  output\[i\] = prefix  
  prefix \*= nums\[i\]

▼

PASS 2: SUFFIX (right → left)

suffix = 1  
For i = n-1 down to 0:  
  output\[i\] \*= suffix  
  suffix \*= nums\[i\]

▼

Return output

### Optimal Trace: nums = \[1, 2, 4, 6\]

#### Pass 1 — Prefix (left → right)

Each `output[i]` gets the product of everything to its left.

| i | prefix (before) | output\[i\] = prefix | prefix \*= nums\[i\] |
| --- | --- | --- | --- |
| 0 | 1 | output\[0\] = **1** | 1 × 1 = 1 |
| 1 | 1 | output\[1\] = **1** | 1 × 2 = 2 |
| 2 | 2 | output\[2\] = **2** | 2 × 4 = 8 |
| 3 | 8 | output\[3\] = **8** | 8 × 6 = 48 |

After Pass 1: `output = [1, 1, 2, 8]` (prefix products only)

#### Pass 2 — Suffix (right → left)

Multiply each `output[i]` by the product of everything to its right.

| i | suffix (before) | output\[i\] \*= suffix | suffix \*= nums\[i\] |
| --- | --- | --- | --- |
| 3 | 1 | 8 × 1 = **8** | 1 × 6 = 6 |
| 2 | 6 | 2 × 6 = **12** | 6 × 4 = 24 |
| 1 | 24 | 1 × 24 = **24** | 24 × 2 = 48 |
| 0 | 48 | 1 × 48 = **48** | 48 × 1 = 48 |

After Pass 2: `output = [48, 24, 12, 8]`

### Visual: Prefix × Suffix Decomposition

output\[i\] = prefix\[i\] × suffix\[i\]

| Index | nums\[i\] | Prefix (left product) | Suffix (right product) | output\[i\] |
| --- | --- | --- | --- | --- |
| 0 | 1 | — (nothing left) | 2 × 4 × 6 = 48 | 1 × 48 = **48** |
| 1 | 2 | 1 | 4 × 6 = 24 | 1 × 24 = **24** |
| 2 | 4 | 1 × 2 = 2 | 6 | 2 × 6 = **12** |
| 3 | 6 | 1 × 2 × 4 = 8 | — (nothing right) | 8 × 1 = **8** |

### Complexity Analysis (Optimal)

| Metric | Value | Why |
| --- | --- | --- |
| Time | **O(n)** | Two linear passes through the array |
| Space | **O(1)** | Only the output array (no extra prefix/suffix arrays) |

### Key Insight

**Product except self = prefix × suffix.** For any index i, the answer is the product of everything to its left (prefix) multiplied by the product of everything to its right (suffix). Two passes — one forward, one backward — build these running products using just a single variable each. No division needed, no extra arrays.

**Why not just divide total product by nums\[i\]?** Division fails when `nums[i] == 0`. The prefix × suffix approach handles zeros naturally — if there's a zero in the array, the prefix or suffix containing it will be zero, and only the position where that zero is excluded will have a nonzero product.

[↑ Back to top](#top)

<a id="longest-consecutive"></a>

Problem 8

## Longest Consecutive Sequence

longestConsecutive() — HashSet + Sequence Start Detection

### Problem Statement

Given an array of integers `nums`, return the length of the longest consecutive sequence of elements that can be formed.

A **consecutive sequence** is a sequence of elements in which each element is exactly 1 greater than the previous element. The elements do not have to be consecutive in the original array.

You must write an algorithm that runs in **O(n)** time.

### Constraints

-   `0 <= nums.length <= 1000`
-   `-109 <= nums[i] <= 109`

### Solution Code

```python
Python
def longestConsecutive(self, nums: List[int]) -> int:
    numSet = set(nums)
    longest = 0

    for num in numSet:
        if (num - 1) not in numSet:
            length = 1
            while (num + length) in numSet:
                length += 1
            longest = max(length, longest)
    return longest
```

### How It Works

The algorithm uses a **HashSet** for O(1) lookups and a clever trick: it only starts counting a sequence from its **smallest element**. For each number, it checks if `num - 1` exists in the set. If it does, this number is *not* the start of a sequence — skip it. If `num - 1` is missing, this number *is* the start, so we count forward (`num+1`, `num+2`, ...) until the chain breaks.

### The Key Trick: Finding Sequence Starts

Only start counting from the beginning of a sequence

Given: `nums = [2, 20, 4, 10, 3, 4, 5]` → `numSet = {2, 3, 4, 5, 10, 20}`

| num | num - 1 in set? | Is sequence start? | Action |
| --- | --- | --- | --- |
| 2 | 1 not in set | **YES — start here** | Count: 2→3→4→5 = length 4 |
| 3 | 2 in set | No — skip | — |
| 4 | 3 in set | No — skip | — |
| 5 | 4 in set | No — skip | — |
| 10 | 9 not in set | **YES — start here** | Count: 10 = length 1 |
| 20 | 19 not in set | **YES — start here** | Count: 20 = length 1 |

Only 3 out of 6 numbers trigger the inner while loop — the rest are skipped in O(1).

### Algorithm Flowchart

For each number in the set

START

▼

numSet = set(nums)  
longest = 0

▼

Get next num from numSet

▼

◆ (num - 1) in numSet? ◆

YES (not a start)

▼

Skip — not the start  
of a sequence

↰ Next num

NO (this IS a start)

▼

length = 1

▼

◆ (num + length) in numSet? ◆

YES → length += 1, ↰ check again

NO → done counting

▼

longest = max(length, longest)

↰ Next num

▼

Return longest

### Step-by-Step Trace

#### Example 1: nums = \[2, 20, 4, 10, 3, 4, 5\]

`numSet = {2, 3, 4, 5, 10, 20}` (duplicates removed)

| num | num-1 in set? | Start? | Count chain | length | longest |
| --- | --- | --- | --- | --- | --- |
| 2 | 1? No | **Yes** | 2→3✔→4✔→5✔→6✘ | 4 | 4 |
| 3 | 2? Yes | Skip | — | — | 4 |
| 4 | 3? Yes | Skip | — | — | 4 |
| 5 | 4? Yes | Skip | — | — | 4 |
| 10 | 9? No | **Yes** | 10→11✘ | 1 | 4 |
| 20 | 19? No | **Yes** | 20→21✘ | 1 | 4 |

Output: **4** (the sequence \[2, 3, 4, 5\])

#### Example 2: nums = \[0, 3, 2, 5, 4, 6, 1, 1\]

`numSet = {0, 1, 2, 3, 4, 5, 6}`

| num | num-1 in set? | Start? | Count chain | length | longest |
| --- | --- | --- | --- | --- | --- |
| 0 | \-1? No | **Yes** | 0→1✔→2✔→3✔→4✔→5✔→6✔→7✘ | 7 | 7 |
| 1 | 0? Yes | Skip | — | — | 7 |
| 2 | 1? Yes | Skip | — | — | 7 |
| 3 | 2? Yes | Skip | — | — | 7 |
| 4 | 3? Yes | Skip | — | — | 7 |
| 5 | 4? Yes | Skip | — | — | 7 |
| 6 | 5? Yes | Skip | — | — | 7 |

Output: **7** (the sequence \[0, 1, 2, 3, 4, 5, 6\])

### Why Is This O(n) and Not O(n²)?

Each element is visited at most twice

It looks like a nested loop (for + while), but consider: the inner `while` loop only runs when we find a **sequence start**. Each element in the array is either:

-   **A sequence start** → checked once in the outer loop, then counted once by the while loop
-   **Not a sequence start** → checked once in the outer loop (O(1) skip), never entered by while

Every element is "touched" at most **twice** total (once as a candidate, once during counting). So the total work across all iterations is O(n), not O(n²).

### Complexity Analysis

| Metric | Value | Why |
| --- | --- | --- |
| Time | **O(n)** | Each element visited at most twice total |
| Space | **O(n)** | HashSet stores all unique elements |

### Key Insight

**Only count from the start of each sequence.** The `(num - 1) not in numSet` check is the entire trick. It ensures we never redundantly count the middle or end of a sequence. We only fire the while loop for sequence-starting elements, making the algorithm O(n) despite the nested loop appearance.

**Why use a set instead of sorting?** Sorting would give O(n log n). The HashSet gives O(1) lookups for both the "is this a start?" check and the "does the next number exist?" check, bringing the whole algorithm down to O(n).

[↑ Back to top](#top)
