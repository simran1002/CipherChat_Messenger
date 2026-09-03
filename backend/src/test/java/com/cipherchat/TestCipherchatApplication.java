package com.cipherchat;

import org.springframework.boot.SpringApplication;

public class TestCipherchatApplication {

	public static void main(String[] args) {
		SpringApplication.from(CipherchatApplication::main).with(TestcontainersConfiguration.class).run(args);
	}

}
